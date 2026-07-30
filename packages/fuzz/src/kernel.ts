// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

import {
  type Atom,
  type GroundFn,
  type ReduceResult,
  atomEq,
  expr,
  gbool,
  gfloat,
  gint,
  gnd,
  groundType,
  gstr,
  gunit,
  registerBuiltinGroundedOperation,
  sym,
  variable,
} from "@mettascript/core";
import { uniformBigInt } from "pure-rand/distribution/uniformBigInt";
import { xorshift128plus, xorshift128plusFromState } from "pure-rand/generator/xorshift128plus";

export const FUZZ_RNG_ALGORITHM = "xorshift128plus-v1";
export const FUZZ_ATOM_KEY_ALGORITHM = "mettascript-atom-key-v1";
export const FUZZ_REPLAY_KEY_ALGORITHM = "mettascript-replay-key-v1";
export const FUZZ_ALPHA_REPLAY_KEY_ALGORITHM = "mettascript-alpha-replay-key-v1";
export const FUZZ_ATOM_CODEC_VERSION = 1;

const RNG_HEAD = sym("FuzzRng");
const RNG_ALGORITHM = sym(FUZZ_RNG_ALGORITHM);
const DRAW_HEAD = sym("FuzzDraw");
const ERROR_HEAD = sym("FuzzKernelError");
const FLOAT_BITS_HEAD = sym("Float64Bits");
const FLOAT_INDEX_HEAD = sym("Float64Index");
const ENCODED_ATOM_HEAD = sym("FuzzEncodedAtom");
const ENCODED_SYMBOL = sym("Symbol");
const ENCODED_VARIABLE = sym("Variable");
const ENCODED_EXPRESSION = sym("Expression");
const ENCODED_INTEGER = sym("Integer");
const ENCODED_FLOAT = sym("Float64Bits");
const ENCODED_STRING = sym("String");
const ENCODED_BOOLEAN = sym("Boolean");
const ENCODED_UNIT = sym("Unit");
const ENCODED_ERROR = sym("Error");
const FUZZ_SAMPLE_HEAD = sym("FuzzSample");
const FUZZ_GENERATION_DISCARD_HEAD = sym("FuzzGenerationDiscard");
const FUZZ_GENERATION_ERROR_HEAD = sym("FuzzGenerationError");
const FUZZ_DRIVER_HEAD = sym("FuzzDriver");
const CUSTOM_REPLAY_TREE_HEAD = sym("CustomReplayTree");
const CUSTOM_REPLAY_SKIP_HEAD = sym("CustomReplaySkip");
const CUSTOM_REPLAY_PROTOCOL_ERROR_HEAD = sym("CustomReplayProtocolError");
const GRAMMAR_FIELD_EXPRESSIONS_HEAD = sym("GrammarFieldExpressions");
const GRAMMAR_TEMPLATE_PROFILE_HEAD = sym("GrammarTemplateProfile");
const GRAMMAR_REQUIREMENT_ALTERNATIVES_HEAD = sym("GrammarRequirementAlternatives");
const GRAMMAR_REQUIREMENT_ALTERNATIVE_HEAD = sym("GrammarRequirementAlternative");
const GRAMMAR_REQUIREMENT_SUMMARY_ENTRY_HEAD = sym("GrammarRequirementSummaryEntry");
const GRAMMAR_VALIDATION_PLAN_HEAD = sym("GrammarValidationPlan");
const GRAMMAR_VALIDATION_FIELD_HEAD = sym("GrammarValidationField");
const GRAMMAR_VALIDATION_SCOPED_ENTER_HEAD = sym("GrammarValidationScopedEnter");
const GRAMMAR_VALIDATION_SCOPED_EXIT_HEAD = sym("GrammarValidationScopedExit");
const GRAMMAR_VALIDATION_MALFORMED_HEAD = sym("GrammarValidationMalformed");
const GRAMMAR_REFERENCE_TARGETS_HEAD = sym("GrammarReferenceTargets");
const GRAMMAR_INDEXED_REFERENCE_HEAD = sym("_FuzzGrammarRef");
const GRAMMAR_ALTERNATIVES_ADD_HEAD = sym("GrammarAlternativesAdd");
const GRAMMAR_PRODUCTIONS_HEAD = sym("GrammarProductions");
const GRAMMAR_TEMPLATE_PLAN_HEAD = sym("GrammarTemplatePlan");
const GI_LIT_HEAD = sym("GILit");
const GI_FIELD_HEAD = sym("GIField");
const GI_REF_HEAD = sym("GIRef");
const GI_FRESH_HEAD = sym("GIFresh");
const GI_USE_HEAD = sym("GIUse");
const GI_BIND_HEAD = sym("GIBind");
const GI_SCOPED_HEAD = sym("GIScoped");
const GI_EXPR_ENTER_HEAD = sym("GIExprEnter");
const GI_EXPR_BUILD_HEAD = sym("GIExprBuild");
const FUZZ_STACK_HEAD = sym("FuzzStack");
const FUZZ_STACK_TAKE_HEAD = sym("FuzzStackTake");
const FUZZ_EXPRESSION_VIEW_HEAD = sym("FuzzExpressionView");
const FUZZ_ATOM_LEAF_HEAD = sym("FuzzAtomLeaf");
const QUOTE_HEAD = sym("quote");
const FUZZ_VARIABLE_MARKER_TYPE = sym("FuzzVariableMarker");
const FUZZ_VARIABLE_MARKER_KIND = "mettascript-fuzz-variable-marker";
const UNICODE_SCALAR_COUNT = 1_112_062n;
const UNICODE_FIRST_GAP_INDEX = 55_296n;
const UNICODE_SECOND_GAP_INDEX = 63_486n;
const GRAMMAR_RESERVED_TEMPLATE_HEADS = new Set([
  "Literal",
  "Field",
  "Ref",
  "Fresh",
  "Use",
  "Bind",
  "Scoped",
]);
const MIN_I32 = -0x80000000;
const MAX_I32 = 0x7fffffff;
const F64_SIGN_BIT = 1n << 63n;
const F64_MAGNITUDE_MASK = F64_SIGN_BIT - 1n;
const F64_POSITIVE_INFINITY_BITS = 0x7ff0000000000000n;
const F64_MIN_INDEX = -F64_POSITIVE_INFINITY_BITS - 1n;
const F64_MAX_INDEX = F64_POSITIVE_INFINITY_BITS;
const floatBuffer = new ArrayBuffer(8);
const floatView = new DataView(floatBuffer);

type RngState = readonly [number, number, number, number];
type KeyMode = "Exact" | "Alpha" | "Replay" | "AlphaReplay";
type KeyResult =
  | { readonly ok: true; readonly key: string }
  | { readonly ok: false; readonly reason: Atom };
type DecodePayload =
  | { readonly tag: "atom"; readonly atom: Atom }
  | { readonly tag: "expression"; readonly children: readonly Atom[] }
  | { readonly tag: "error"; readonly error: Atom };

const ok = (result: Atom): ReduceResult => ({ tag: "ok", results: [result] });

// Narrows the `parsed-list | kernel-error-atom` unions the parsing helpers return;
// `Array.isArray` alone does not narrow a readonly array out of such a union.
function isErrorAtom<T>(value: readonly T[] | Atom): value is Atom {
  return !Array.isArray(value);
}

function kernelError(code: string, ...details: Atom[]): Atom {
  return expr([ERROR_HEAD, sym(code), ...details]);
}

function operationError(code: string, operation: string, detail: string): ReduceResult {
  return ok(kernelError(code, expr([sym("Operation"), sym(operation)]), sym(detail)));
}

function arityError(operation: string, expected: number, actual: number): ReduceResult {
  return ok(
    kernelError(
      "InvalidArity",
      expr([sym("Operation"), sym(operation)]),
      expr([sym("Expected"), gint(expected)]),
      expr([sym("Actual"), gint(actual)]),
    ),
  );
}

function exactIntegerValue(atom: Atom): bigint | undefined {
  return atom.kind === "gnd" && atom.value.g === "int" ? BigInt(atom.value.n) : undefined;
}

function integralNumberValue(atom: Atom): bigint | undefined {
  const exact = exactIntegerValue(atom);
  if (exact !== undefined) return exact;
  if (
    atom.kind !== "gnd" ||
    atom.value.g !== "float" ||
    !Number.isFinite(atom.value.n) ||
    !Number.isInteger(atom.value.n)
  )
    return undefined;
  return BigInt(atom.value.n);
}

function floatValue(atom: Atom): number | undefined {
  return atom.kind === "gnd" && atom.value.g === "float" ? atom.value.n : undefined;
}

function float64Bits(value: number): bigint {
  floatView.setFloat64(0, value, false);
  return (BigInt(floatView.getUint32(0, false)) << 32n) | BigInt(floatView.getUint32(4, false));
}

function float64FromBits(bits: bigint): number {
  floatView.setUint32(0, Number(bits >> 32n), false);
  floatView.setUint32(4, Number(bits & 0xffffffffn), false);
  return floatView.getFloat64(0, false);
}

function float64Words(value: number): readonly [bigint, bigint] {
  const bits = float64Bits(value);
  return [bits >> 32n, bits & 0xffffffffn];
}

function unsigned32Value(atom: Atom): bigint | undefined {
  const value = exactIntegerValue(atom);
  return value !== undefined && value >= 0n && value <= 0xffffffffn ? value : undefined;
}

function float64FromWords(high: bigint, low: bigint): number {
  return float64FromBits((high << 32n) | low);
}

function float64Index(value: number): bigint | undefined {
  if (Number.isNaN(value)) return undefined;
  const bits = float64Bits(value);
  const magnitude = bits & F64_MAGNITUDE_MASK;
  return (bits & F64_SIGN_BIT) === 0n ? magnitude : -magnitude - 1n;
}

function float64FromIndex(index: bigint): number | undefined {
  if (index < F64_MIN_INDEX || index > F64_MAX_INDEX) return undefined;
  const bits = index < 0n ? F64_SIGN_BIT | (-index - 1n) : index;
  return float64FromBits(bits);
}

function rngStateAtom(state: readonly number[]): Atom {
  return expr([RNG_HEAD, RNG_ALGORITHM, ...state.map(gint)]);
}

function parseRngState(atom: Atom): RngState | undefined {
  if (
    atom.kind !== "expr" ||
    atom.items.length !== 6 ||
    !atomEq(atom.items[0]!, RNG_HEAD) ||
    !atomEq(atom.items[1]!, RNG_ALGORITHM)
  ) {
    return undefined;
  }
  const state: number[] = [];
  for (const part of atom.items.slice(2)) {
    const value = exactIntegerValue(part);
    if (value === undefined || value < BigInt(MIN_I32) || value > BigInt(MAX_I32)) return undefined;
    state.push(Number(value));
  }
  if (state.every((value) => value === 0)) return undefined;
  return [state[0]!, state[1]!, state[2]!, state[3]!];
}

const rngInit: GroundFn = (args) => {
  if (args.length !== 1) return arityError("_fuzz-rng-init", 1, args.length);
  const seed = integralNumberValue(args[0]!);
  if (seed === undefined) return operationError("InvalidSeed", "_fuzz-rng-init", "ExpectedInteger");
  const seed32 = Number(BigInt.asIntN(32, seed));
  return ok(rngStateAtom(xorshift128plus(seed32).getState()));
};

const drawInt: GroundFn = (args) => {
  if (args.length !== 3) return arityError("_fuzz-draw-int", 3, args.length);
  const state = parseRngState(args[0]!);
  if (state === undefined)
    return operationError("InvalidRngState", "_fuzz-draw-int", "ExpectedFuzzRng");
  const lower = integralNumberValue(args[1]!);
  const upper = integralNumberValue(args[2]!);
  if (lower === undefined || upper === undefined)
    return operationError("InvalidBounds", "_fuzz-draw-int", "ExpectedIntegers");
  if (lower > upper) return operationError("InvalidBounds", "_fuzz-draw-int", "LowerExceedsUpper");

  const rng = xorshift128plusFromState(state);
  const value = uniformBigInt(rng, lower, upper);
  return ok(expr([DRAW_HEAD, gint(value), rngStateAtom(rng.getState())]));
};

function lengthPrefixed(tag: string, value: string): string {
  return `${tag}${value.length}:${value};`;
}

function nonReplayable(reason: string): KeyResult {
  return {
    ok: false,
    reason: kernelError("NonReplayableGroundedValue", sym(reason)),
  };
}

function groundedKey(atom: Extract<Atom, { readonly kind: "gnd" }>, mode: KeyMode): KeyResult {
  if (atom.value.g === "ext") return nonReplayable("ExternalGrounded");
  if (atom.exec !== undefined) return nonReplayable("ExecutableGrounded");
  if (atom.match !== undefined) return nonReplayable("CustomMatcher");
  if (!atomEq(atom.typ, groundType(atom.value))) return nonReplayable("CustomGroundedType");

  // The two switches below are deliberately parallel rather than factored together. They agree on the
  // scalar kinds and differ on numbers, which is the whole point: a replay key must separate values a
  // rerun has to reproduce exactly, so an integer keeps its own kind and a float keys on its bits, while
  // an identity key must match core's numeric equality and keys both on the Number projection. Sharing
  // the agreeing arms would save four lines and hide the one distinction a reader has to check.
  if (mode === "Replay" || mode === "AlphaReplay") {
    switch (atom.value.g) {
      case "int":
        return { ok: true, key: `I${atom.value.n};` };
      case "float":
        return { ok: true, key: `F${float64Bits(atom.value.n).toString(16).padStart(16, "0")};` };
      case "str":
        return { ok: true, key: lengthPrefixed("T", atom.value.s) };
      case "bool":
        return { ok: true, key: atom.value.b ? "B1;" : "B0;" };
      case "unit":
        return { ok: true, key: "U;" };
      case "error":
        return { ok: true, key: lengthPrefixed("R", atom.value.msg) };
    }
  }

  switch (atom.value.g) {
    case "int":
    case "float":
      // Core numeric equality compares the Number projection across integer and float kinds. Matching
      // that projection avoids false negatives; large integers can share a bucket, so consumers still
      // confirm a key hit with exact atom equality.
      return { ok: true, key: lengthPrefixed("N", String(Number(atom.value.n))) };
    case "str":
      return { ok: true, key: lengthPrefixed("T", atom.value.s) };
    case "bool":
      return { ok: true, key: atom.value.b ? "B1;" : "B0;" };
    case "unit":
      return { ok: true, key: "U;" };
    case "error":
      return { ok: true, key: lengthPrefixed("R", atom.value.msg) };
  }
}

function structuralAtomKey(atom: Atom, mode: KeyMode): KeyResult {
  const algorithm =
    mode === "Replay"
      ? FUZZ_REPLAY_KEY_ALGORITHM
      : mode === "AlphaReplay"
        ? FUZZ_ALPHA_REPLAY_KEY_ALGORITHM
        : FUZZ_ATOM_KEY_ALGORITHM;
  const output = [`${algorithm};`];
  const variables = new Map<string, string>();
  const pending: Atom[] = [atom];

  while (pending.length > 0) {
    const current = pending.pop()!;
    switch (current.kind) {
      case "sym":
        output.push(lengthPrefixed("S", current.name));
        break;
      case "var": {
        let name = current.name;
        if (mode === "Alpha" || mode === "AlphaReplay") {
          const known = variables.get(name);
          if (known === undefined) {
            name = `%${variables.size}`;
            variables.set(current.name, name);
          } else {
            name = known;
          }
        }
        output.push(lengthPrefixed("V", name));
        break;
      }
      case "expr":
        output.push(`E${current.items.length}:`);
        for (let index = current.items.length - 1; index >= 0; index -= 1) {
          pending.push(current.items[index]!);
        }
        break;
      case "gnd": {
        const encoded = groundedKey(current, mode);
        if (!encoded.ok) return encoded;
        output.push(encoded.key);
        break;
      }
    }
  }
  return { ok: true, key: output.join("") };
}

const atomKey: GroundFn = (args) => {
  if (args.length !== 2) return arityError("_fuzz-atom-key", 2, args.length);
  const mode = args[0]!;
  if (
    mode.kind !== "sym" ||
    (mode.name !== "Exact" &&
      mode.name !== "Alpha" &&
      mode.name !== "Replay" &&
      mode.name !== "AlphaReplay")
  )
    return operationError("InvalidKeyMode", "_fuzz-atom-key", "ExpectedKeyMode");
  const result = structuralAtomKey(args[1]!, mode.name);
  return ok(result.ok ? gstr(result.key) : result.reason);
};

function atomsEqualForKeyMode(left: Atom, right: Atom, mode: "Exact" | "Replay"): boolean {
  return mode === "Replay" ? replayAtomEqual(left, right) : atomEq(left, right);
}

function deduplicateAtoms(
  args: readonly Atom[],
  operation: "_fuzz-deduplicate-exact" | "_fuzz-deduplicate-replay",
  mode: "Exact" | "Replay",
): ReduceResult {
  if (args.length !== 1) return arityError(operation, 1, args.length);
  const values = args[0]!;
  if (values.kind !== "expr")
    return operationError("InvalidDeduplicationInput", operation, "ExpectedExpression");

  const buckets = new Map<string, Atom[]>();
  const unique: Atom[] = [];
  for (const value of values.items) {
    const encoded = structuralAtomKey(value, mode);
    if (!encoded.ok) return ok(encoded.reason);
    const bucket = buckets.get(encoded.key);
    if (bucket?.some((seen) => atomsEqualForKeyMode(seen, value, mode)) === true) continue;
    if (bucket === undefined) buckets.set(encoded.key, [value]);
    else bucket.push(value);
    unique.push(value);
  }
  return ok(expr(unique));
}

const deduplicateExact: GroundFn = (args) =>
  deduplicateAtoms(args, "_fuzz-deduplicate-exact", "Exact");

const deduplicateReplay: GroundFn = (args) =>
  deduplicateAtoms(args, "_fuzz-deduplicate-replay", "Replay");

function memberAtom(
  args: readonly Atom[],
  operation: "_fuzz-exact-member" | "_fuzz-replay-member",
  mode: "Exact" | "Replay",
): ReduceResult {
  if (args.length !== 2) return arityError(operation, 2, args.length);
  const values = args[1]!;
  if (values.kind !== "expr")
    return operationError("InvalidMembershipInput", operation, "ExpectedExpression");

  const needle = args[0]!;
  const needleKey = structuralAtomKey(needle, mode);
  if (!needleKey.ok) return ok(needleKey.reason);
  for (const value of values.items) {
    const valueKey = structuralAtomKey(value, mode);
    if (!valueKey.ok) return ok(valueKey.reason);
    if (valueKey.key === needleKey.key && atomsEqualForKeyMode(value, needle, mode))
      return ok(gbool(true));
  }
  return ok(gbool(false));
}

const exactMember: GroundFn = (args) => memberAtom(args, "_fuzz-exact-member", "Exact");

const replayMember: GroundFn = (args) => memberAtom(args, "_fuzz-replay-member", "Replay");

const makeVariable: GroundFn = (args) => {
  if (args.length !== 1) return arityError("_fuzz-make-variable", 1, args.length);
  const index = integralNumberValue(args[0]!);
  if (index === undefined || index < 0n)
    return operationError(
      "InvalidVariableIndex",
      "_fuzz-make-variable",
      "ExpectedNonNegativeInteger",
    );
  return ok(variable(`fuzz-${index}`));
};

const variableMarker: GroundFn = (args) => {
  if (args.length !== 1) return arityError("_fuzz-variable-marker", 1, args.length);
  const index = integralNumberValue(args[0]!);
  if (index === undefined || index < 0n)
    return operationError(
      "InvalidVariableIndex",
      "_fuzz-variable-marker",
      "ExpectedNonNegativeInteger",
    );
  return ok(
    gnd(
      { g: "ext", kind: FUZZ_VARIABLE_MARKER_KIND, id: index.toString() },
      FUZZ_VARIABLE_MARKER_TYPE,
    ),
  );
};

const containsVariableMarker: GroundFn = (args) => {
  if (args.length !== 1) return arityError("_fuzz-contains-variable-marker", 1, args.length);
  const pending: Atom[] = [args[0]!];
  while (pending.length > 0) {
    const atom = pending.pop()!;
    if (
      atom.kind === "gnd" &&
      atom.value.g === "ext" &&
      atom.value.kind === FUZZ_VARIABLE_MARKER_KIND
    ) {
      return ok(gbool(true));
    }
    if (atom.kind !== "expr") continue;
    for (let index = atom.items.length - 1; index >= 0; index -= 1)
      pending.push(atom.items[index]!);
  }
  return ok(gbool(false));
};

type MaterializedAtom =
  | { readonly ok: true; readonly atom: Atom }
  | { readonly ok: false; readonly error: Atom };

function materializeGeneratedVariables(root: Atom): MaterializedAtom {
  type Frame = {
    readonly children: readonly Atom[];
    index: number;
    readonly materialized: Atom[];
  };

  const frames: Frame[] = [];
  let current = root;
  let completed: Atom | undefined;

  for (;;) {
    if (
      current.kind === "gnd" &&
      current.value.g === "ext" &&
      current.value.kind === FUZZ_VARIABLE_MARKER_KIND
    ) {
      let index: bigint;
      try {
        index = BigInt(current.value.id);
      } catch {
        index = -1n;
      }
      if (index < 0n || index.toString() !== current.value.id)
        return {
          ok: false,
          error: kernelError(
            "InvalidVariableMarker",
            expr([sym("Operation"), sym("_fuzz-materialize-grammar-sample")]),
            sym("ExpectedCanonicalNonNegativeInteger"),
          ),
        };
      completed = variable(`fuzz-${index}`);
    } else if (current.kind === "expr") {
      if (current.items.length > 0) {
        frames.push({ children: current.items, index: 1, materialized: [] });
        current = current.items[0]!;
        continue;
      } else {
        completed = current;
      }
    } else {
      completed = current;
    }

    for (;;) {
      const frame = frames.at(-1);
      if (frame === undefined) return { ok: true, atom: completed };
      frame.materialized.push(completed);
      if (frame.index < frame.children.length) {
        current = frame.children[frame.index]!;
        frame.index += 1;
        break;
      }
      frames.pop();
      completed = expr(frame.materialized);
    }
  }
}

const materializeGrammarSample: GroundFn = (args) => {
  if (args.length !== 3) return arityError("_fuzz-materialize-grammar-sample", 3, args.length);
  const materialized = materializeGeneratedVariables(args[0]!);
  if (!materialized.ok) return ok(materialized.error);
  return ok(expr([FUZZ_SAMPLE_HEAD, materialized.atom, args[1]!, args[2]!]));
};

const appendExpressionItem: GroundFn = (args) => {
  if (args.length !== 2) return arityError("_fuzz-expression-append", 2, args.length);
  const values = args[0]!;
  if (values.kind !== "expr")
    return operationError(
      "InvalidExpressionAppendInput",
      "_fuzz-expression-append",
      "ExpectedExpression",
    );
  return ok(expr([...values.items, args[1]!]));
};

const concatenateExpressions: GroundFn = (args) => {
  if (args.length !== 2) return arityError("_fuzz-expression-concat", 2, args.length);
  const [left, right] = args;
  if (left!.kind !== "expr" || right!.kind !== "expr")
    return operationError(
      "InvalidExpressionConcatInput",
      "_fuzz-expression-concat",
      "ExpectedExpressions",
    );
  return ok(expr([...left!.items, ...right!.items]));
};

type GrammarSummaryEntry = {
  readonly target: Atom;
  readonly alternatives: Extract<Atom, { readonly kind: "expr" }>;
  readonly encoded: Atom;
};

function grammarSummaryEntries(
  summary: Atom,
  operation: string,
): readonly GrammarSummaryEntry[] | Atom {
  if (summary.kind !== "expr")
    return kernelError(
      "InvalidGrammarRequirementSummary",
      expr([sym("Operation"), sym(operation)]),
      sym("ExpectedExpression"),
    );

  const entries: GrammarSummaryEntry[] = [];
  for (const encoded of summary.items) {
    if (
      encoded.kind !== "expr" ||
      encoded.items.length !== 3 ||
      encoded.items[0]!.kind !== "sym" ||
      encoded.items[0]!.name !== GRAMMAR_REQUIREMENT_SUMMARY_ENTRY_HEAD.name
    ) {
      return kernelError(
        "InvalidGrammarRequirementSummary",
        expr([sym("Operation"), sym(operation)]),
        sym("MalformedEntry"),
      );
    }
    const quotedTarget = encoded.items[1]!;
    const alternatives = encoded.items[2]!;
    if (
      quotedTarget.kind !== "expr" ||
      quotedTarget.items.length !== 2 ||
      quotedTarget.items[0]!.kind !== "sym" ||
      quotedTarget.items[0]!.name !== QUOTE_HEAD.name ||
      alternatives.kind !== "expr"
    ) {
      return kernelError(
        "InvalidGrammarRequirementSummary",
        expr([sym("Operation"), sym(operation)]),
        sym("MalformedEntry"),
      );
    }
    for (const alternative of alternatives.items) {
      if (
        alternative.kind !== "expr" ||
        alternative.items.length !== 2 ||
        alternative.items[0]!.kind !== "sym" ||
        alternative.items[0]!.name !== GRAMMAR_REQUIREMENT_ALTERNATIVE_HEAD.name ||
        alternative.items[1]!.kind !== "expr"
      ) {
        return kernelError(
          "InvalidGrammarRequirementSummary",
          expr([sym("Operation"), sym(operation)]),
          sym("MalformedAlternative"),
        );
      }
    }
    entries.push({
      target: quotedTarget.items[1]!,
      alternatives,
      encoded,
    });
  }
  return entries;
}

const grammarSummaryAlternatives: GroundFn = (args) => {
  if (args.length !== 2) return arityError("_fuzz-grammar-summary-alternatives", 2, args.length);
  const entries = grammarSummaryEntries(args[0]!, "_fuzz-grammar-summary-alternatives");
  if (isErrorAtom(entries)) return ok(entries);
  const found = entries.find((entry) => atomEq(entry.target, args[1]!));
  return ok(expr([GRAMMAR_REQUIREMENT_ALTERNATIVES_HEAD, found?.alternatives ?? expr([])]));
};

const grammarSummaryReplace: GroundFn = (args) => {
  if (args.length !== 3) return arityError("_fuzz-grammar-summary-replace", 3, args.length);
  const entries = grammarSummaryEntries(args[0]!, "_fuzz-grammar-summary-replace");
  if (isErrorAtom(entries)) return ok(entries);
  const alternatives = args[2]!;
  if (alternatives.kind !== "expr")
    return operationError(
      "InvalidGrammarRequirementSummary",
      "_fuzz-grammar-summary-replace",
      "ExpectedAlternativesExpression",
    );
  for (const alternative of alternatives.items) {
    if (
      alternative.kind !== "expr" ||
      alternative.items.length !== 2 ||
      alternative.items[0]!.kind !== "sym" ||
      alternative.items[0]!.name !== GRAMMAR_REQUIREMENT_ALTERNATIVE_HEAD.name ||
      alternative.items[1]!.kind !== "expr"
    ) {
      return operationError(
        "InvalidGrammarRequirementSummary",
        "_fuzz-grammar-summary-replace",
        "MalformedAlternative",
      );
    }
  }

  const replacement = expr([
    GRAMMAR_REQUIREMENT_SUMMARY_ENTRY_HEAD,
    expr([QUOTE_HEAD, args[1]!]),
    alternatives,
  ]);
  const updated: Atom[] = [];
  let replaced = false;
  for (const entry of entries) {
    if (atomEq(entry.target, args[1]!)) {
      if (!replaced) updated.push(replacement);
      replaced = true;
    } else {
      updated.push(entry.encoded);
    }
  }
  if (!replaced) updated.push(replacement);
  return ok(expr(updated));
};

const expressionView: GroundFn = (args) => {
  if (args.length !== 1) return arityError("_fuzz-expression-view", 1, args.length);
  const atom = args[0]!;
  if (atom.kind !== "expr") return ok(expr([FUZZ_ATOM_LEAF_HEAD]));
  const quoted = atom.items.map((item) => expr([QUOTE_HEAD, item]));
  return ok(
    expr([
      FUZZ_EXPRESSION_VIEW_HEAD,
      expr([sym("Arity"), gint(atom.items.length)]),
      expr([sym("Forward"), expr(quoted)]),
      expr([sym("Reversed"), expr([...quoted].reverse())]),
    ]),
  );
};

function grammarTemplateChildIndices(atom: Atom): readonly number[] {
  if (atom.kind !== "expr" || atom.items.length === 0 || atom.items[0]!.kind !== "sym") return [];
  const head = atom.items[0]!.name;
  if (
    head === "Literal" ||
    head === "Field" ||
    head === "Ref" ||
    head === "Fresh" ||
    head === "Use"
  )
    return [];
  if (head === "Bind" && atom.items.length === 3) return [2];
  if (head === "Scoped" && atom.items.length === 3) return [2];
  return atom.items.map((_, index) => index);
}

// Walks a template's relevant children without host recursion, visiting every two-item
// expression headed by `leafHead` and descending everywhere else.
function scanTemplateLeaves(
  root: Atom,
  leafHead: string,
  visit: (leaf: Extract<Atom, { readonly kind: "expr" }>) => void,
): void {
  const pending: Atom[] = [root];
  while (pending.length > 0) {
    const atom = pending.pop()!;
    if (
      atom.kind === "expr" &&
      atom.items.length === 2 &&
      atom.items[0]!.kind === "sym" &&
      atom.items[0]!.name === leafHead
    ) {
      visit(atom);
      continue;
    }
    const indices = grammarTemplateChildIndices(atom);
    for (let index = indices.length - 1; index >= 0; index -= 1)
      pending.push((atom as Extract<Atom, { readonly kind: "expr" }>).items[indices[index]!]!);
  }
}

// Bottom-up template rewrite without host recursion: every two-item expression headed by
// `leafHead` is replaced with `rewrite(leaf)`, every other node is rebuilt around its
// template-relevant children. `rewrite` returning null aborts the walk and the caller reports
// its own error.
function rewriteTemplateLeaves(
  root: Atom,
  leafHead: string,
  rewrite: (leaf: Extract<Atom, { readonly kind: "expr" }>) => Atom | null,
): Atom | null {
  type Task =
    | { readonly tag: "visit"; readonly atom: Atom }
    | {
        readonly tag: "build";
        readonly atom: Extract<Atom, { readonly kind: "expr" }>;
        readonly indices: readonly number[];
      };
  const pending: Task[] = [{ tag: "visit", atom: root }];
  const completed: Atom[] = [];
  while (pending.length > 0) {
    const task = pending.pop()!;
    if (task.tag === "build") {
      const built = completed.splice(completed.length - task.indices.length, task.indices.length);
      const items = [...task.atom.items];
      for (let index = 0; index < task.indices.length; index += 1)
        items[task.indices[index]!] = built[index]!;
      completed.push(expr(items));
      continue;
    }

    const atom = task.atom;
    if (
      atom.kind === "expr" &&
      atom.items.length === 2 &&
      atom.items[0]!.kind === "sym" &&
      atom.items[0]!.name === leafHead
    ) {
      const replaced = rewrite(atom);
      if (replaced === null) return null;
      completed.push(replaced);
      continue;
    }

    const indices = grammarTemplateChildIndices(atom);
    if (indices.length === 0 || atom.kind !== "expr") {
      completed.push(atom);
      continue;
    }
    pending.push({ tag: "build", atom, indices });
    for (let index = indices.length - 1; index >= 0; index -= 1)
      pending.push({ tag: "visit", atom: atom.items[indices[index]!]! });
  }
  return completed[0]!;
}

const grammarFieldExpressions: GroundFn = (args) => {
  if (args.length !== 1) return arityError("_fuzz-grammar-field-expressions", 1, args.length);
  const fields: Atom[] = [];
  scanTemplateLeaves(args[0]!, "Field", (field) => {
    fields.push(expr([QUOTE_HEAD, field.items[1]!]));
  });
  return ok(expr([GRAMMAR_FIELD_EXPRESSIONS_HEAD, expr(fields)]));
};

const replaceGrammarFields: GroundFn = (args) => {
  if (args.length !== 2) return arityError("_fuzz-grammar-replace-fields", 2, args.length);
  const replacements = args[1]!;
  if (replacements.kind !== "expr")
    return operationError(
      "InvalidGrammarFieldReplacements",
      "_fuzz-grammar-replace-fields",
      "ExpectedExpression",
    );

  let replacementIndex = 0;
  const rebuilt = rewriteTemplateLeaves(args[0]!, "Field", (field) => {
    const replacement = replacements.items[replacementIndex];
    if (replacement === undefined) return null;
    replacementIndex += 1;
    return expr([field.items[0]!, replacement]);
  });
  if (rebuilt === null)
    return operationError(
      "InvalidGrammarFieldReplacements",
      "_fuzz-grammar-replace-fields",
      "MissingReplacement",
    );
  if (replacementIndex !== replacements.items.length)
    return operationError(
      "InvalidGrammarFieldReplacements",
      "_fuzz-grammar-replace-fields",
      "TrailingReplacement",
    );
  return ok(rebuilt);
};

const indexGrammarReferences: GroundFn = (args) => {
  if (args.length !== 1) return arityError("_fuzz-grammar-index-references", 1, args.length);
  let total = 0;
  scanTemplateLeaves(args[0]!, "Ref", () => {
    total += 1;
  });

  let ordinal = 0;
  const rebuilt = rewriteTemplateLeaves(args[0]!, "Ref", (reference) => {
    const indexed = expr([
      GRAMMAR_INDEXED_REFERENCE_HEAD,
      reference.items[1]!,
      gint(ordinal),
      gint(total),
    ]);
    ordinal += 1;
    return indexed;
  });
  return ok(rebuilt!);
};

const grammarTemplateProfile: GroundFn = (args) => {
  if (args.length !== 1) return arityError("_fuzz-grammar-template-profile", 1, args.length);
  const root = args[0]!;
  const pending: Array<readonly [Atom, number]> = [[root, 1]];
  let references = 0;
  let minimumNextId = 0n;
  let nodes = 0;
  let maximumDepth = 0;

  while (pending.length > 0) {
    const [atom, depth] = pending.pop()!;
    nodes += 1;
    maximumDepth = Math.max(maximumDepth, depth);
    if (atom.kind === "expr" && atom.items.length > 0 && atom.items[0]!.kind === "sym") {
      const head = atom.items[0]!.name;
      if (head === "Ref" && atom.items.length === 2) references += 1;
      if (head === "Scoped" && atom.items.length === 3) {
        const bindings = atom.items[1]!;
        if (bindings.kind === "expr") {
          for (const binding of bindings.items) {
            if (
              binding.kind === "expr" &&
              binding.items.length === 3 &&
              binding.items[0]!.kind === "sym" &&
              binding.items[0]!.name === "Binding"
            ) {
              const id = integralNumberValue(binding.items[2]!);
              if (id !== undefined && id >= 0n)
                minimumNextId = minimumNextId > id ? minimumNextId : id + 1n;
            }
          }
        }
      }
    }
    const indices = grammarTemplateChildIndices(atom);
    for (let index = indices.length - 1; index >= 0; index -= 1) {
      pending.push([
        (atom as Extract<Atom, { readonly kind: "expr" }>).items[indices[index]!]!,
        depth + 1,
      ]);
    }
  }

  return ok(
    expr([
      GRAMMAR_TEMPLATE_PROFILE_HEAD,
      expr([sym("Ground"), gbool(root.ground)]),
      expr([sym("References"), gint(references)]),
      expr([sym("MinimumNextId"), gint(minimumNextId)]),
      expr([sym("Nodes"), gint(nodes)]),
      expr([sym("Depth"), gint(maximumDepth)]),
    ]),
  );
};

// ---- requirement-set and alternatives algebra ----
// Pure set operations on the shapes the productivity analysis threads through its folds:
// a requirement list `((quote sort) ...)` and an alternatives list
// `((GrammarRequirementAlternative requirements) ...)`. The MeTTa side keeps the policy
// (event dispatch, fixed-point iteration, what counts as productive); these ops replace
// per-element MeTTa recursion whose cost made dominance pruning quadratic with a large
// constant. Equality is exact structural equality, the same relation as `noreduce-eq`.

type ParsedAlternative = {
  readonly encoded: Atom;
  readonly requirements: readonly Atom[];
};

function parseRequirementList(atom: Atom, operation: string): readonly Atom[] | Atom {
  if (atom.kind !== "expr")
    return kernelError(
      "InvalidGrammarRequirement",
      expr([sym("Operation"), sym(operation)]),
      sym("ExpectedExpression"),
    );
  const sorts: Atom[] = [];
  for (const quoted of atom.items) {
    if (
      quoted.kind !== "expr" ||
      quoted.items.length !== 2 ||
      quoted.items[0]!.kind !== "sym" ||
      quoted.items[0]!.name !== QUOTE_HEAD.name
    )
      return kernelError(
        "InvalidGrammarRequirement",
        expr([sym("Operation"), sym(operation)]),
        sym("MalformedRequirement"),
      );
    sorts.push(quoted.items[1]!);
  }
  return sorts;
}

function parseAlternativeList(atom: Atom, operation: string): readonly ParsedAlternative[] | Atom {
  if (atom.kind !== "expr")
    return kernelError(
      "InvalidGrammarRequirementAlternatives",
      expr([sym("Operation"), sym(operation)]),
      sym("ExpectedExpression"),
    );
  const parsed: ParsedAlternative[] = [];
  for (const alternative of atom.items) {
    if (
      alternative.kind !== "expr" ||
      alternative.items.length !== 2 ||
      alternative.items[0]!.kind !== "sym" ||
      alternative.items[0]!.name !== GRAMMAR_REQUIREMENT_ALTERNATIVE_HEAD.name
    )
      return kernelError(
        "InvalidGrammarRequirementAlternatives",
        expr([sym("Operation"), sym(operation)]),
        sym("MalformedAlternative"),
      );
    const requirements = parseRequirementList(alternative.items[1]!, operation);
    if (isErrorAtom(requirements)) return requirements;
    parsed.push({ encoded: alternative, requirements });
  }
  return parsed;
}

function requirementMember(sort: Atom, requirements: readonly Atom[]): boolean {
  return requirements.some((candidate) => atomEq(candidate, sort));
}

function requirementSubset(left: readonly Atom[], right: readonly Atom[]): boolean {
  return left.every((sort) => requirementMember(sort, right));
}

function encodeRequirements(sorts: readonly Atom[]): Atom {
  return expr(sorts.map((sort) => expr([QUOTE_HEAD, sort])));
}

function encodeAlternative(sorts: readonly Atom[]): Atom {
  return expr([GRAMMAR_REQUIREMENT_ALTERNATIVE_HEAD, encodeRequirements(sorts)]);
}

// Mirrors `add-requirement-alternative`: a candidate dominated by an existing entry is
// dropped; otherwise entries the candidate dominates are pruned and it is appended.
function alternativesAddCore(
  alternatives: ParsedAlternative[],
  candidate: readonly Atom[],
): boolean {
  for (const existing of alternatives)
    if (requirementSubset(existing.requirements, candidate)) return false;
  const kept = alternatives.filter(
    (existing) => !requirementSubset(candidate, existing.requirements),
  );
  kept.push({ encoded: encodeAlternative(candidate), requirements: candidate });
  alternatives.length = 0;
  alternatives.push(...kept);
  return true;
}

function encodeAlternatives(alternatives: readonly ParsedAlternative[]): Atom {
  return expr(alternatives.map((alternative) => alternative.encoded));
}

const grammarAlternativesAdd: GroundFn = (args) => {
  if (args.length !== 2) return arityError("_fuzz-grammar-alternatives-add", 2, args.length);
  const alternatives = parseAlternativeList(args[0]!, "_fuzz-grammar-alternatives-add");
  if (isErrorAtom(alternatives)) return ok(alternatives);
  const candidate = parseRequirementList(args[1]!, "_fuzz-grammar-alternatives-add");
  if (isErrorAtom(candidate)) return ok(candidate);
  const mutable = [...alternatives];
  const changed = alternativesAddCore(mutable, candidate);
  return ok(
    expr([
      GRAMMAR_ALTERNATIVES_ADD_HEAD,
      gbool(changed),
      changed ? encodeAlternatives(mutable) : args[0]!,
    ]),
  );
};

// Mirrors `combine-requirement-alternatives`: left entries outer, right entries inner,
// each union (left sorts first, new right sorts in right order) added with pruning into
// one accumulator threaded across the whole cross product.

function removeSortFromAlternatives(
  alternatives: readonly ParsedAlternative[],
  sort: Atom,
): ParsedAlternative[] {
  const reduced: ParsedAlternative[] = [];
  for (const alternative of alternatives) {
    const kept = alternative.requirements.filter((candidate) => !atomEq(candidate, sort));
    alternativesAddCore(reduced, kept);
  }
  return reduced;
}

// ---- production lookup ----
// Both per-target lookups take `(productions (quote target))`; parse that shape once, with the
// caller's own error identity on a mismatch.
function parseProductionsTargetArgs(
  args: readonly Atom[],
  code: string,
  operation: string,
):
  | { readonly productions: Extract<Atom, { readonly kind: "expr" }>; readonly target: Atom }
  | ReduceResult {
  if (args.length !== 2) return arityError(operation, 2, args.length);
  const productions = args[0]!;
  const quotedTarget = args[1]!;
  if (
    productions.kind !== "expr" ||
    quotedTarget.kind !== "expr" ||
    quotedTarget.items.length !== 2 ||
    quotedTarget.items[0]!.kind !== "sym" ||
    quotedTarget.items[0]!.name !== QUOTE_HEAD.name
  )
    return operationError(code, operation, "ExpectedProductionsAndQuotedTarget");
  return { productions, target: quotedTarget.items[1]! };
}

// The per-target scan over every production ran per reference-eligibility check, once per
// nonterminal per level; indexed by the productions atom's identity it costs one scan per
// grammar per process.
const productionsForTargetCache = new WeakMap<Atom, Map<string, Atom>>();

const grammarProductionsForTarget: GroundFn = (args) => {
  const parsed = parseProductionsTargetArgs(
    args,
    "InvalidGrammarProductionLookup",
    "_fuzz-grammar-productions-for-target",
  );
  if ("tag" in parsed) return parsed;
  const { productions, target } = parsed;
  const targetKey = structuralAtomKey(target, "Exact");
  if (!targetKey.ok) return ok(targetKey.reason);

  let byTarget = productionsForTargetCache.get(productions);
  if (byTarget === undefined) {
    byTarget = new Map();
    for (const production of productions.items) {
      if (
        production.kind !== "expr" ||
        production.items.length !== 5 ||
        production.items[0]!.kind !== "sym" ||
        production.items[0]!.name !== "GrammarProduction" ||
        production.items[3]!.kind !== "expr" ||
        production.items[3]!.items.length !== 2 ||
        production.items[3]!.items[0]!.kind !== "sym" ||
        production.items[3]!.items[0]!.name !== QUOTE_HEAD.name
      )
        return operationError(
          "InvalidGrammarProductionLookup",
          "_fuzz-grammar-productions-for-target",
          "MalformedProduction",
        );
      const candidateKey = structuralAtomKey(production.items[3]!.items[1]!, "Exact");
      if (!candidateKey.ok) return ok(candidateKey.reason);
      const bucket = byTarget.get(candidateKey.key);
      if (bucket === undefined) byTarget.set(candidateKey.key, expr([production]));
      else
        byTarget.set(
          candidateKey.key,
          expr([...(bucket as Extract<Atom, { readonly kind: "expr" }>).items, production]),
        );
    }
    productionsForTargetCache.set(productions, byTarget);
  }
  return ok(expr([GRAMMAR_PRODUCTIONS_HEAD, byTarget.get(targetKey.key) ?? expr([])]));
};

// ---- requirement analysis ----
// The full binder-requirement analysis of one template against the current summary, as one pure
// call: template syntax in, `(GrammarRequirementAlternatives ...)` out. The event-stream fold this
// replaces ran ~30 interpreted steps per production; at one grounded call the worklist's per-analysis
// cost is the set algebra itself. Semantics per node: `Use s` contributes the singleton requirement
// {s}; a reference contributes the referenced target's current alternatives; an expression combines
// its dynamic children pairwise (union with dominance pruning); `Bind`/`Scoped` discharge their sorts
// from the body's alternatives; a template with no dynamic content is closed (one empty requirement).
function summaryAlternativesFor(
  entries: readonly GrammarSummaryEntry[],
  target: Atom,
): readonly ParsedAlternative[] | Atom {
  const found = entries.find((entry) => atomEq(entry.target, target));
  if (found === undefined) return [];
  return parseAlternativeList(found.alternatives, "_fuzz-grammar-template-requirements");
}

function combineAlternatives(
  left: readonly ParsedAlternative[],
  right: readonly ParsedAlternative[],
): ParsedAlternative[] {
  const combined: ParsedAlternative[] = [];
  for (const leftEntry of left) {
    for (const rightEntry of right) {
      const union = [...leftEntry.requirements];
      for (const sort of rightEntry.requirements)
        if (!requirementMember(sort, union)) union.push(sort);
      alternativesAddCore(combined, union);
    }
  }
  return combined;
}

type RequirementNode = {
  readonly dynamic: boolean;
  readonly alternatives: readonly ParsedAlternative[];
};

// A worklist analysis presents the same summary atom to many productions before a merge
// replaces it; parsing it once per version (with a target index) keeps each analysis O(its
// own template) instead of O(summary).
type ParsedSummary = {
  readonly entries: readonly GrammarSummaryEntry[];
  readonly byTarget: Map<string, readonly ParsedAlternative[] | Atom>;
};
const parsedSummaryCache = new WeakMap<Atom, ParsedSummary | Atom>();

function parsedSummaryFor(summary: Atom): ParsedSummary | Atom {
  const cached = parsedSummaryCache.get(summary);
  if (cached !== undefined) return cached;
  const entries = grammarSummaryEntries(summary, "_fuzz-grammar-template-requirements-op");
  const result: ParsedSummary | Atom = isErrorAtom(entries)
    ? entries
    : { entries, byTarget: new Map() };
  parsedSummaryCache.set(summary, result);
  return result;
}

function summaryAlternativesCached(
  parsed: ParsedSummary,
  target: Atom,
): readonly ParsedAlternative[] | Atom {
  const key = structuralAtomKey(target, "Exact");
  if (!key.ok) return key.reason;
  const cached = parsed.byTarget.get(key.key);
  if (cached !== undefined) return cached;
  const computed = summaryAlternativesFor(parsed.entries, target);
  parsed.byTarget.set(key.key, computed);
  return computed;
}

type AlternativesLookup = (target: Atom) => readonly ParsedAlternative[] | Atom;

const grammarTemplateRequirements: GroundFn = (args) => {
  if (args.length !== 2)
    return arityError("_fuzz-grammar-template-requirements-op", 2, args.length);
  const parsedSummary = parsedSummaryFor(args[1]!);
  if (!("entries" in (parsedSummary as object))) return ok(parsedSummary as Atom);
  const summaryIndex = parsedSummary as ParsedSummary;
  const analyzed = analyzeTemplateRequirements(args[0]!, (target) =>
    summaryAlternativesCached(summaryIndex, target),
  );
  if (isErrorAtom(analyzed)) return ok(analyzed);
  return ok(expr([GRAMMAR_REQUIREMENT_ALTERNATIVES_HEAD, encodeAlternatives(analyzed)]));
};

function analyzeTemplateRequirements(
  template: Atom,
  lookup: AlternativesLookup,
): ParsedAlternative[] | Atom {
  type Task =
    | { readonly tag: "visit"; readonly atom: Atom }
    | { readonly tag: "discharge"; readonly sorts: readonly Atom[] }
    | { readonly tag: "combine"; readonly childCount: number };
  const pending: Task[] = [{ tag: "visit", atom: template }];
  const results: RequirementNode[] = [];
  const staticNode: RequirementNode = { dynamic: false, alternatives: [] };

  while (pending.length > 0) {
    const task = pending.pop()!;
    if (task.tag === "discharge") {
      const child = results.pop()!;
      if (!child.dynamic) {
        results.push(child);
        continue;
      }
      let reduced = [...child.alternatives];
      for (const sort of task.sorts) reduced = removeSortFromAlternatives(reduced, sort);
      results.push({ dynamic: true, alternatives: reduced });
      continue;
    }
    if (task.tag === "combine") {
      const children = results.splice(results.length - task.childCount, task.childCount);
      const dynamicChildren = children.filter((child) => child.dynamic);
      if (dynamicChildren.length === 0) {
        results.push(staticNode);
        continue;
      }
      let alternatives = dynamicChildren[0]!.alternatives;
      for (let index = 1; index < dynamicChildren.length; index += 1)
        alternatives = combineAlternatives(alternatives, dynamicChildren[index]!.alternatives);
      results.push({ dynamic: true, alternatives });
      continue;
    }

    const atom = task.atom;
    if (atom.kind === "expr" && atom.items.length > 0 && atom.items[0]!.kind === "sym") {
      const head = atom.items[0]!.name;
      if ((head === "Literal" || head === "Field" || head === "Fresh") && atom.items.length === 2) {
        results.push(staticNode);
        continue;
      }
      // marker: heads handled below

      if (head === "Use" && atom.items.length === 2) {
        results.push({
          dynamic: true,
          alternatives: [
            {
              encoded: encodeAlternative([atom.items[1]!]),
              requirements: [atom.items[1]!],
            },
          ],
        });
        continue;
      }
      if (
        (head === "Ref" && atom.items.length === 2) ||
        (head === GRAMMAR_INDEXED_REFERENCE_HEAD.name && atom.items.length === 4)
      ) {
        const referenced = lookup(atom.items[1]!);
        if (isErrorAtom(referenced)) return referenced;
        results.push({ dynamic: true, alternatives: referenced });
        continue;
      }
      if (head === "Bind" && atom.items.length === 3) {
        pending.push({ tag: "discharge", sorts: [atom.items[1]!] });
        pending.push({ tag: "visit", atom: atom.items[2]! });
        continue;
      }
      if (head === "Scoped" && atom.items.length === 3) {
        const bindings = atom.items[1]!;
        if (bindings.kind !== "expr")
          return kernelError(
            "InvalidGrammarTemplate",
            expr([sym("Operation"), sym("_fuzz-grammar-template-requirements-op")]),
            sym("MalformedScopedBindings"),
          );
        const sorts: Atom[] = [];
        for (const binding of bindings.items) {
          if (
            binding.kind !== "expr" ||
            binding.items.length !== 3 ||
            binding.items[0]!.kind !== "sym" ||
            binding.items[0]!.name !== "Binding"
          )
            return kernelError(
              "InvalidGrammarTemplate",
              expr([sym("Operation"), sym("_fuzz-grammar-template-requirements-op")]),
              sym("MalformedScopedBindings"),
            );
          sorts.push(binding.items[1]!);
        }
        pending.push({ tag: "discharge", sorts });
        pending.push({ tag: "visit", atom: atom.items[2]! });
        continue;
      }
    }
    if (atom.kind === "expr" && atom.items.length > 0) {
      pending.push({ tag: "combine", childCount: atom.items.length });
      for (let index = atom.items.length - 1; index >= 0; index -= 1)
        pending.push({ tag: "visit", atom: atom.items[index]! });
      continue;
    }
    results.push(staticNode);
  }

  if (results.length !== 1)
    return kernelError(
      "InvalidGrammarTemplate",
      expr([sym("Operation"), sym("_fuzz-grammar-template-requirements-op")]),
      sym("InvalidTraversalResult"),
    );
  const root = results[0]!;
  return root.dynamic
    ? [...root.alternatives]
    : [{ encoded: encodeAlternative([]), requirements: [] as Atom[] }];
}

// The whole productivity fixed point in one call: an internal worklist over production
// indices, alternatives per target held as plain arrays, and dependents re-enqueued when a
// merge changes a target. Pure syntax analysis, so the fixed point is the same one the
// specification machine reaches; the caller shapes the final error.
const grammarProductivityOp: GroundFn = (args) => {
  if (args.length !== 3) return arityError("_fuzz-grammar-productivity-op", 3, args.length);
  const [productionsAtom, quotedRoot, targetsAtom] = args;
  const root = quotedRoot === undefined ? undefined : unquote(quotedRoot);
  if (productionsAtom!.kind !== "expr" || root === undefined || targetsAtom!.kind !== "expr")
    return operationError(
      "InvalidGrammarProductivity",
      "_fuzz-grammar-productivity-op",
      "ExpectedProductionsRootTargets",
    );
  const productions = productionsAtom!.items;

  type Analysis = {
    readonly targetKey: string;
    readonly target: Atom;
    readonly template: Atom;
  };
  const analyses: Analysis[] = [];
  for (const production of productions) {
    if (
      production.kind !== "expr" ||
      production.items.length !== 5 ||
      production.items[3]!.kind !== "expr" ||
      production.items[3]!.items.length !== 2 ||
      production.items[4]!.kind !== "expr" ||
      production.items[4]!.items.length !== 2
    )
      return operationError(
        "InvalidGrammarProductivity",
        "_fuzz-grammar-productivity-op",
        "MalformedProduction",
      );
    const target = production.items[3]!.items[1]!;
    const key = structuralAtomKey(target, "Exact");
    if (!key.ok) return ok(key.reason);
    analyses.push({ targetKey: key.key, target, template: production.items[4]!.items[1]! });
  }

  const dependents = new Map<string, number[]>();
  for (let index = 0; index < analyses.length; index += 1) {
    for (const referenced of templateReferenceTargetAtoms(analyses[index]!.template)) {
      const key = structuralAtomKey(referenced, "Exact");
      if (!key.ok) return ok(key.reason);
      const bucket = dependents.get(key.key);
      if (bucket === undefined) dependents.set(key.key, [index]);
      else if (bucket[bucket.length - 1] !== index) bucket.push(index);
    }
  }

  const summary = new Map<string, ParsedAlternative[]>();
  const lookup: AlternativesLookup = (target) => {
    const key = structuralAtomKey(target, "Exact");
    if (!key.ok) return key.reason;
    return summary.get(key.key) ?? [];
  };

  const queue: number[] = [];
  for (let index = analyses.length - 1; index >= 0; index -= 1) queue.push(index);
  while (queue.length > 0) {
    const index = queue.pop()!;
    const analysis = analyses[index]!;
    const alternatives = analyzeTemplateRequirements(analysis.template, lookup);
    if (isErrorAtom(alternatives)) return ok(alternatives);
    const current = summary.get(analysis.targetKey) ?? [];
    let changed = false;
    for (const alternative of alternatives)
      if (alternativesAddCore(current, alternative.requirements)) changed = true;
    if (!changed) continue;
    summary.set(analysis.targetKey, current);
    const affected = dependents.get(analysis.targetKey);
    if (affected !== undefined)
      for (let position = affected.length - 1; position >= 0; position -= 1)
        queue.push(affected[position]!);
  }

  for (const quotedTarget of targetsAtom!.items) {
    const target = unquote(quotedTarget);
    if (target === undefined)
      return operationError(
        "InvalidGrammarProductivity",
        "_fuzz-grammar-productivity-op",
        "MalformedTarget",
      );
    const key = structuralAtomKey(target, "Exact");
    if (!key.ok) return ok(key.reason);
    if ((summary.get(key.key) ?? []).length === 0)
      return ok(expr([sym("GrammarUnproductive"), quoteAtom(target)]));
  }
  const rootKey = structuralAtomKey(root, "Exact");
  if (!rootKey.ok) return ok(rootKey.reason);
  const rootClosed = (summary.get(rootKey.key) ?? []).some(
    (alternative) => alternative.requirements.length === 0,
  );
  if (!rootClosed) return ok(expr([sym("GrammarUnproductive"), quoteAtom(root)]));
  return ok(expr([sym("ValidGrammarProductivity")]));
};

// ---- eligibility ----
// Whether each production of a target can complete within a size budget under a lexical scope,
// exactly the recursive fit semantics: `Use` needs its sort in scope, a reference needs size > 0
// and an eligible target at the deterministic split size, `Bind` extends the scope with a fit
// placeholder, `Scoped` validates disjoint binding ids and extends the scope, everything else
// walks its children. Pure and deterministic, memoised per productions atom by
// (target, size, scope) — reference sizes strictly decrease, so the recursion is well-founded.
type FitScopeEntry = { readonly sort: Atom; readonly id: Atom | undefined };

const eligibilityCache = new WeakMap<Atom, Map<string, Atom>>();

function scopeEntriesFrom(scope: Atom, operation: string): FitScopeEntry[] | Atom {
  if (scope.kind !== "expr")
    return kernelError(
      "InvalidGrammarScope",
      expr([sym("Operation"), sym(operation)]),
      sym("ExpectedExpression"),
    );
  const out: FitScopeEntry[] = [];
  for (const binding of scope.items) {
    if (
      binding.kind !== "expr" ||
      binding.items.length !== 3 ||
      binding.items[0]!.kind !== "sym" ||
      binding.items[0]!.name !== "GrammarBinding" ||
      binding.items[1]!.kind !== "expr" ||
      binding.items[1]!.items.length !== 2 ||
      binding.items[1]!.items[0]!.kind !== "sym" ||
      binding.items[1]!.items[0]!.name !== QUOTE_HEAD.name
    )
      return kernelError(
        "InvalidGrammarScope",
        expr([sym("Operation"), sym(operation)]),
        sym("MalformedBinding"),
      );
    out.push({ sort: binding.items[1]!.items[1]!, id: binding.items[2]! });
  }
  return out;
}

function scopeCacheKey(entries: readonly FitScopeEntry[]): string | Atom {
  const parts: string[] = [];
  for (const entry of entries) {
    const sortKey = structuralAtomKey(entry.sort, "Exact");
    if (!sortKey.ok) return sortKey.reason;
    const idKey = entry.id === undefined ? "" : structuralAtomKey(entry.id, "Exact");
    if (typeof idKey !== "string" && !idKey.ok) return idKey.reason;
    parts.push(`${sortKey.key}=${typeof idKey === "string" ? idKey : idKey.key}`);
  }
  return [...new Set(parts)].sort().join(" ");
}

function referenceChildSize(size: bigint, ordinal: bigint, total: bigint): bigint {
  const budget = size - 1n < 0n ? 0n : size - 1n;
  const base = budget / total;
  const remainder = budget % total;
  return base + (ordinal < remainder ? 1n : 0n);
}

type FitOutcome = boolean | { readonly error: Atom };

const grammarEligibleProductions: GroundFn = (args) => {
  if (args.length !== 4) return arityError("_fuzz-grammar-eligible-productions-op", 4, args.length);
  const [productionsAtom, quotedTarget, scopeAtom, sizeAtom] = args;
  const size = integralNumberValue(sizeAtom!);
  if (size === undefined)
    return operationError(
      "InvalidGrammarEligibility",
      "_fuzz-grammar-eligible-productions-op",
      "ExpectedIntegerSize",
    );
  if (
    productionsAtom!.kind !== "expr" ||
    quotedTarget!.kind !== "expr" ||
    quotedTarget!.items.length !== 2 ||
    quotedTarget!.items[0]!.kind !== "sym" ||
    quotedTarget!.items[0]!.name !== QUOTE_HEAD.name
  )
    return operationError(
      "InvalidGrammarEligibility",
      "_fuzz-grammar-eligible-productions-op",
      "ExpectedProductionsAndQuotedTarget",
    );
  const scopeEntries = scopeEntriesFrom(scopeAtom!, "_fuzz-grammar-eligible-productions-op");
  if (!Array.isArray(scopeEntries)) return ok(scopeEntries);

  let cache = eligibilityCache.get(productionsAtom!);
  if (cache === undefined) {
    cache = new Map();
    eligibilityCache.set(productionsAtom!, cache);
  }

  const productionsFor = (target: Atom): readonly Atom[] | Atom => {
    const looked = grammarProductionsForTarget([productionsAtom!, expr([QUOTE_HEAD, target])]);
    if (looked.tag !== "ok" || looked.results.length !== 1)
      return kernelError(
        "InvalidGrammarEligibility",
        expr([sym("Operation"), sym("_fuzz-grammar-eligible-productions-op")]),
        sym("ProductionLookupFailed"),
      );
    const result = looked.results[0]!;
    if (
      result.kind !== "expr" ||
      result.items.length !== 2 ||
      result.items[0]!.kind !== "sym" ||
      result.items[0]!.name !== GRAMMAR_PRODUCTIONS_HEAD.name ||
      result.items[1]!.kind !== "expr"
    )
      return result;
    return result.items[1]!.items;
  };

  function fitsTemplate(
    template: Atom,
    scope: readonly FitScopeEntry[],
    templateSize: bigint,
  ): FitOutcome {
    type FitTask = { readonly atom: Atom; readonly scope: readonly FitScopeEntry[] };
    const tasks: FitTask[] = [{ atom: template, scope }];
    while (tasks.length > 0) {
      const task = tasks.pop()!;
      const atom = task.atom;
      if (atom.kind !== "expr" || atom.items.length === 0) continue;
      const h = atom.items[0]!;
      if (h.kind === "sym") {
        const head = h.name;
        if ((head === "Literal" || head === "Field" || head === "Fresh") && atom.items.length === 2)
          continue;
        if (head === "Use" && atom.items.length === 2) {
          const sort = atom.items[1]!;
          if (!task.scope.some((entry) => atomEq(entry.sort, sort))) return false;
          continue;
        }
        if (
          (head === "Ref" && atom.items.length === 2) ||
          (head === GRAMMAR_INDEXED_REFERENCE_HEAD.name && atom.items.length === 4)
        ) {
          if (templateSize <= 0n) return false;
          let ordinal = 0n;
          let total = 1n;
          if (atom.items.length === 4) {
            const seenOrdinal = integralNumberValue(atom.items[2]!);
            const seenTotal = integralNumberValue(atom.items[3]!);
            if (
              seenOrdinal === undefined ||
              seenTotal === undefined ||
              seenTotal <= 0n ||
              seenOrdinal < 0n ||
              seenOrdinal >= seenTotal
            )
              return {
                error: kernelError(
                  "InvalidGrammarEligibility",
                  expr([sym("Operation"), sym("_fuzz-grammar-eligible-productions-op")]),
                  sym("MalformedIndexedReference"),
                ),
              };
            ordinal = seenOrdinal;
            total = seenTotal;
          }
          const childSize = referenceChildSize(templateSize, ordinal, total);
          const eligible = eligibleFor(atom.items[1]!, task.scope, childSize);
          if (typeof eligible !== "boolean") return eligible;
          if (!eligible) return false;
          continue;
        }
        if (head === "Bind" && atom.items.length === 3) {
          tasks.push({
            atom: atom.items[2]!,
            scope: [{ sort: atom.items[1]!, id: undefined }, ...task.scope],
          });
          continue;
        }
        if (head === "Scoped" && atom.items.length === 3) {
          const bindings = atom.items[1]!;
          if (bindings.kind !== "expr")
            return {
              error: kernelError(
                "InvalidGrammarEligibility",
                expr([sym("Operation"), sym("_fuzz-grammar-eligible-productions-op")]),
                sym("MalformedScopedBindings"),
              ),
            };
          const added: FitScopeEntry[] = [];
          for (const binding of bindings.items) {
            if (
              binding.kind !== "expr" ||
              binding.items.length !== 3 ||
              binding.items[0]!.kind !== "sym" ||
              binding.items[0]!.name !== "Binding"
            )
              return {
                error: kernelError(
                  "InvalidGrammarEligibility",
                  expr([sym("Operation"), sym("_fuzz-grammar-eligible-productions-op")]),
                  sym("MalformedScopedBindings"),
                ),
              };
            added.push({ sort: binding.items[1]!, id: binding.items[2]! });
          }
          for (const entry of added)
            if (
              entry.id !== undefined &&
              task.scope.some(
                (existing) => existing.id !== undefined && atomEq(existing.id, entry.id!),
              )
            )
              return {
                error: expr([sym("FitDuplicateGrammarBindingId"), expr([QUOTE_HEAD, bindings])]),
              };
          tasks.push({ atom: atom.items[2]!, scope: [...added, ...task.scope] });
          continue;
        }
      }
      for (let index = atom.items.length - 1; index >= 0; index -= 1)
        tasks.push({ atom: atom.items[index]!, scope: task.scope });
    }
    return true;
  }

  function eligibleFor(
    target: Atom,
    scope: readonly FitScopeEntry[],
    targetSize: bigint,
  ): boolean | { readonly error: Atom } {
    const list = eligibleListFor(target, scope, targetSize);
    if (list.kind !== "expr") return { error: list };
    return list.items.length > 0;
  }

  function eligibleListFor(
    target: Atom,
    scope: readonly FitScopeEntry[],
    targetSize: bigint,
  ): Atom {
    const targetKey = structuralAtomKey(target, "Exact");
    if (!targetKey.ok) return targetKey.reason;
    const scopeKey = scopeCacheKey(scope);
    if (typeof scopeKey !== "string") return scopeKey;
    const key = `${targetKey.key}#${targetSize}#${scopeKey}`;
    const cached = cache!.get(key);
    if (cached !== undefined) return cached;
    const candidates = productionsFor(target);
    if (isErrorAtom(candidates)) return candidates;
    const eligible: Atom[] = [];
    for (const production of candidates) {
      if (
        production.kind !== "expr" ||
        production.items.length !== 5 ||
        production.items[4]!.kind !== "expr" ||
        production.items[4]!.items.length !== 2
      )
        return kernelError(
          "InvalidGrammarEligibility",
          expr([sym("Operation"), sym("_fuzz-grammar-eligible-productions-op")]),
          sym("MalformedProduction"),
        );
      const outcome = fitsTemplate(production.items[4]!.items[1]!, scope, targetSize);
      if (typeof outcome !== "boolean") return outcome.error;
      if (outcome) eligible.push(production);
    }
    const result = expr([sym("EligibleGrammarProductions"), expr(eligible)]);
    cache!.set(key, result);
    return result;
  }

  return ok(eligibleListFor(quotedTarget!.items[1]!, scopeEntries, size));
};

function rngStateOf(atom: Atom): RngState | undefined {
  return parseRngState(atom);
}

function rngAtomOf(state: RngState): Atom {
  return rngStateAtom(state);
}

function drawIntFromState(state: RngState, lower: bigint, upper: bigint): [bigint, RngState] {
  const rng = xorshift128plusFromState(state);
  const value = uniformBigInt(rng, lower, upper);
  return [value, rng.getState() as RngState];
}

// Flattens a decision tree to its Int leaves in order — the replay drivers' input. The MeTTa
// flattener appended per node, which is quadratic in leaf count and drowned wide trees in
// garbage; one iterative pass is linear. Shapes are the drivers' own: a six-item Int decision
// is a leaf, any other five-item decision recurses into its children.
const decisionLeaves: GroundFn = (args) => {
  if (args.length !== 1) return arityError("_fuzz-decision-leaves-op", 1, args.length);
  const leaves: Atom[] = [];
  const pending: Atom[] = [args[0]!];
  while (pending.length > 0) {
    const decision = pending.pop()!;
    if (
      decision.kind === "expr" &&
      decision.items.length === 6 &&
      decision.items[0]!.kind === "sym" &&
      decision.items[0]!.name === DECISION_HEAD.name &&
      decision.items[1]!.kind === "sym" &&
      decision.items[1]!.name === "Int" &&
      decision.items[5]!.kind === "expr" &&
      decision.items[5]!.items.length === 0
    ) {
      leaves.push(decision);
      continue;
    }
    if (
      decision.kind === "expr" &&
      decision.items.length === 5 &&
      decision.items[0]!.kind === "sym" &&
      decision.items[0]!.name === DECISION_HEAD.name &&
      decision.items[4]!.kind === "expr"
    ) {
      const children = decision.items[4]!.items;
      for (let index = children.length - 1; index >= 0; index -= 1) pending.push(children[index]!);
      continue;
    }
    return ok(
      expr([
        FUZZ_GENERATION_ERROR_HEAD,
        sym("MalformedDecisionTree"),
        expr([sym("Details"), expr([sym("Decision"), decision])]),
      ]),
    );
  }
  return ok(expr([sym("FuzzDecisionLeaves"), expr(leaves)]));
};

// ---- the kernel grammar machine ----
// The grammar machine's pure transitions run here; the MeTTa module keeps the same machine as
// an executable specification (`_fuzz-gen-*`), drives this one through a bare-tail trampoline,
// and supplies every effect: a `Field` or `Use` sub-generation suspends the machine with an
// `(EvaluateGenerator generator driver size)` request, and the trampoline answers it with
// `fuzz-generate` so user callbacks and custom generators stay ordinary MeTTa. Driver-integer
// transitions replicate 15-drivers.metta exactly (same candidate lists, same decision atoms,
// same error taxonomy); the engine's integer `/` truncates toward zero and `%` keeps the
// dividend's sign, which BigInt arithmetic reproduces bit for bit. Every driver mode is
// deterministic, including the exhaustive cursor, which reads its planned offset (or descends
// leftmost) and records one frame per decision. Suspended states round-trip as the
// specification machine's own state atoms, so replay determinism never depends on hidden host
// state.

type MachineDriver =
  | { readonly mode: "Random"; readonly rng: RngState }
  | { readonly mode: "Edge"; readonly index: bigint }
  | { readonly mode: "Replay"; readonly leaves: readonly Atom[]; readonly cursor: bigint }
  | {
      readonly mode: "ShrinkReplay";
      readonly leaves: readonly Atom[];
      readonly cursor: bigint;
    }
  | {
      readonly mode: "Exhaustive";
      readonly choices: readonly bigint[];
      readonly cursor: bigint;
      readonly frames: readonly Atom[];
    }
  | { readonly mode: "Bytes"; readonly bytes: readonly Atom[]; readonly cursor: bigint };

type MachineFrame =
  | {
      readonly tag: "plan";
      readonly instrs: readonly Atom[];
      cursor: number;
      readonly size: bigint;
    }
  | { readonly tag: "expr"; readonly arity: number; readonly depth: number }
  | { readonly tag: "ref"; readonly target: Atom }
  | {
      readonly tag: "prod";
      readonly target: Atom;
      readonly productionIndex: Atom;
      readonly position: number;
      readonly choiceTree: Atom;
    }
  | {
      readonly tag: "bind";
      readonly sort: Atom;
      readonly bindingId: bigint;
      readonly variable: Atom;
    }
  | { readonly tag: "scoped"; readonly added: Atom }
  | { readonly tag: "scope"; readonly saved: readonly Atom[] };

type MachineState = {
  readonly source: Atom;
  readonly productions: Atom;
  frames: MachineFrame[];
  values: Atom[];
  trees: Atom[];
  scope: Atom[];
  nextId: bigint;
  driver: MachineDriver;
  cut: { readonly reason: Atom; tree: Atom } | undefined;
};

type MachineOutcome =
  | { readonly tag: "done"; readonly result: Atom }
  | { readonly tag: "need"; readonly state: Atom; readonly request: Atom };

const GEN_RUN_HEAD = sym("FuzzGenRun");
const GEN_CUT_HEAD = sym("FuzzGenCut");
const GF_HEAD = sym("GF");
const GFB_SYM = sym("GFB");
const FUZZ_STACK_BOTTOM_SYM = sym("FuzzStackBottom");
const MACHINE_DONE_HEAD = sym("GrammarMachineDone");
const MACHINE_NEED_HEAD = sym("GrammarMachineNeed");
const MACHINE_START_HEAD = sym("GrammarMachineStart");
const MACHINE_RESUME_HEAD = sym("GrammarMachineResume");
const EVALUATE_GENERATOR_HEAD = sym("EvaluateGenerator");
const DECISION_HEAD = sym("Decision");

function machineError(code: string, ...details: Atom[]): Atom {
  return expr([FUZZ_GENERATION_ERROR_HEAD, sym(code), expr([sym("Details"), ...details])]);
}

function quoteAtom(a: Atom): Atom {
  return expr([QUOTE_HEAD, a]);
}

function intDecisionAtom(lower: bigint, upper: bigint, origin: bigint, value: bigint): Atom {
  return expr([
    DECISION_HEAD,
    sym("Int"),
    expr([sym("Bounds"), gint(lower), gint(upper)]),
    expr([sym("Origin"), gint(origin)]),
    expr([sym("Value"), gint(value)]),
    expr([]),
  ]);
}

function decodeDriver(atom: Atom): MachineDriver | Atom {
  if (
    atom.kind !== "expr" ||
    atom.items.length !== 3 ||
    atom.items[0]!.kind !== "sym" ||
    atom.items[0]!.name !== FUZZ_DRIVER_HEAD.name ||
    atom.items[1]!.kind !== "sym"
  )
    return machineError("MalformedDriver", expr([sym("Driver"), atom]));
  const mode = atom.items[1]!.name;
  const payload = atom.items[2]!;
  if (mode === "Random") {
    const rng = rngStateOf(payload);
    if (rng === undefined) return machineError("MalformedDriver", expr([sym("Driver"), atom]));
    return { mode: "Random", rng };
  }
  if (mode === "Edge") {
    const index = integralNumberValue(payload);
    if (index === undefined || index < 0n)
      return machineError("MalformedDriver", expr([sym("Driver"), atom]));
    return { mode: "Edge", index };
  }
  if (mode === "Replay" || mode === "ShrinkReplay") {
    const stateHead = mode === "Replay" ? "ReplayState" : "ShrinkReplayState";
    if (
      payload.kind !== "expr" ||
      payload.items.length !== 3 ||
      payload.items[0]!.kind !== "sym" ||
      payload.items[0]!.name !== stateHead ||
      payload.items[1]!.kind !== "expr"
    )
      return machineError("MalformedDriver", expr([sym("Driver"), atom]));
    const cursor = integralNumberValue(payload.items[2]!);
    if (cursor === undefined) return machineError("MalformedDriver", expr([sym("Driver"), atom]));
    return mode === "Replay"
      ? { mode: "Replay", leaves: payload.items[1]!.items, cursor }
      : { mode: "ShrinkReplay", leaves: payload.items[1]!.items, cursor };
  }
  if (mode === "Exhaustive") {
    if (
      payload.kind !== "expr" ||
      payload.items.length !== 4 ||
      payload.items[0]!.kind !== "sym" ||
      payload.items[0]!.name !== "ExhaustiveCursor" ||
      payload.items[1]!.kind !== "expr" ||
      payload.items[3]!.kind !== "expr"
    )
      return machineError("MalformedExhaustiveState", expr([sym("State"), payload]));
    const choices: bigint[] = [];
    for (const item of payload.items[1]!.items) {
      const choice = integralNumberValue(item);
      if (choice === undefined)
        return machineError("MalformedExhaustiveState", expr([sym("State"), payload]));
      choices.push(choice);
    }
    const cursor = integralNumberValue(payload.items[2]!);
    if (cursor === undefined || cursor < 0n)
      return machineError("MalformedExhaustiveState", expr([sym("State"), payload]));
    return { mode: "Exhaustive", choices, cursor, frames: payload.items[3]!.items };
  }
  if (mode === "Bytes") {
    if (
      payload.kind !== "expr" ||
      payload.items.length !== 3 ||
      payload.items[0]!.kind !== "sym" ||
      payload.items[0]!.name !== "BytesState" ||
      payload.items[1]!.kind !== "expr"
    )
      return machineError("MalformedByteState", expr([sym("State"), payload]));
    const cursor = integralNumberValue(payload.items[2]!);
    if (cursor === undefined)
      return machineError("MalformedByteState", expr([sym("State"), payload]));
    return { mode: "Bytes", bytes: payload.items[1]!.items, cursor };
  }
  return machineError("MalformedDriver", expr([sym("Driver"), atom]));
}

function encodeDriver(driver: MachineDriver): Atom {
  switch (driver.mode) {
    case "Random":
      return expr([FUZZ_DRIVER_HEAD, sym("Random"), rngAtomOf(driver.rng)]);
    case "Edge":
      return expr([FUZZ_DRIVER_HEAD, sym("Edge"), gint(driver.index)]);
    case "Replay":
      return expr([
        FUZZ_DRIVER_HEAD,
        sym("Replay"),
        expr([sym("ReplayState"), expr([...driver.leaves]), gint(driver.cursor)]),
      ]);
    case "ShrinkReplay":
      return expr([
        FUZZ_DRIVER_HEAD,
        sym("ShrinkReplay"),
        expr([sym("ShrinkReplayState"), expr([...driver.leaves]), gint(driver.cursor)]),
      ]);
    case "Exhaustive":
      return expr([
        FUZZ_DRIVER_HEAD,
        sym("Exhaustive"),
        expr([
          sym("ExhaustiveCursor"),
          expr(driver.choices.map((choice) => gint(choice))),
          gint(driver.cursor),
          expr([...driver.frames]),
        ]),
      ]);
    case "Bytes":
      return expr([
        FUZZ_DRIVER_HEAD,
        sym("Bytes"),
        expr([sym("BytesState"), expr([...driver.bytes]), gint(driver.cursor)]),
      ]);
  }
}

type IntChoice =
  | {
      readonly tag: "one";
      readonly value: bigint;
      readonly driver: MachineDriver;
      readonly decision: Atom;
    }
  | { readonly tag: "error"; readonly error: Atom };

function inspectIntLeaf(
  leaf: Atom,
  lower: bigint,
  upper: bigint,
  origin: bigint,
):
  | { readonly tag: "compatible"; readonly value: bigint }
  | { readonly tag: "out-of-bounds"; readonly value: bigint }
  | { readonly tag: "metadata"; readonly bounds: readonly [Atom, Atom]; readonly origin: Atom }
  | { readonly tag: "malformed" } {
  if (
    leaf.kind !== "expr" ||
    leaf.items.length !== 6 ||
    leaf.items[0]!.kind !== "sym" ||
    leaf.items[0]!.name !== DECISION_HEAD.name ||
    leaf.items[1]!.kind !== "sym" ||
    leaf.items[1]!.name !== "Int" ||
    leaf.items[5]!.kind !== "expr" ||
    leaf.items[5]!.items.length !== 0
  )
    return { tag: "malformed" };
  const bounds = leaf.items[2]!;
  const originAtom = leaf.items[3]!;
  const valueAtom = leaf.items[4]!;
  if (
    bounds.kind !== "expr" ||
    bounds.items.length !== 3 ||
    originAtom.kind !== "expr" ||
    originAtom.items.length !== 2 ||
    valueAtom.kind !== "expr" ||
    valueAtom.items.length !== 2
  )
    return { tag: "malformed" };
  const seenLower = integralNumberValue(bounds.items[1]!);
  const seenUpper = integralNumberValue(bounds.items[2]!);
  const seenOrigin = integralNumberValue(originAtom.items[1]!);
  const value = integralNumberValue(valueAtom.items[1]!);
  if (
    seenLower === undefined ||
    seenUpper === undefined ||
    seenOrigin === undefined ||
    value === undefined
  )
    return { tag: "malformed" };
  if (seenLower !== lower || seenUpper !== upper || seenOrigin !== origin)
    return {
      tag: "metadata",
      bounds: [bounds.items[1]!, bounds.items[2]!],
      origin: originAtom.items[1]!,
    };
  if (value < lower || value > upper) return { tag: "out-of-bounds", value };
  return { tag: "compatible", value };
}

function driverInt(driver: MachineDriver, lower: bigint, upper: bigint, origin: bigint): IntChoice {
  if (lower > upper)
    return {
      tag: "error",
      error: machineError("InvalidIntegerBounds", expr([sym("Bounds"), gint(lower), gint(upper)])),
    };
  switch (driver.mode) {
    case "Random": {
      const [value, next] = drawIntFromState(driver.rng, lower, upper);
      return {
        tag: "one",
        value,
        driver: { mode: "Random", rng: next },
        decision: intDecisionAtom(lower, upper, origin, value),
      };
    }
    case "Edge": {
      const candidates: bigint[] = [];
      const add = (candidate: bigint): void => {
        if (candidate < lower || candidate > upper) return;
        if (!candidates.includes(candidate)) candidates.push(candidate);
      };
      add(origin);
      add(lower);
      add(upper);
      add(0n);
      add(-1n);
      add(1n);
      add((lower + upper) / 2n);
      const count = BigInt(candidates.length);
      const position = driver.index % count;
      const value = candidates[Number(position)]!;
      return {
        tag: "one",
        value,
        driver: { mode: "Edge", index: driver.index + 1n },
        decision: intDecisionAtom(lower, upper, origin, value),
      };
    }
    case "Replay": {
      if (driver.leaves.length === 0)
        return {
          tag: "error",
          error: machineError(
            "ReplayMismatch",
            expr([sym("Path"), gint(driver.cursor)]),
            expr([
              sym("Expected"),
              expr([
                DECISION_HEAD,
                sym("Int"),
                expr([sym("Bounds"), gint(lower), gint(upper)]),
                expr([sym("Origin"), gint(origin)]),
                expr([sym("Value"), sym("Any")]),
                expr([]),
              ]),
            ]),
            expr([sym("Actual"), sym("EndOfTrace")]),
          ),
        };
      const leaf = driver.leaves[0]!;
      const inspected = inspectIntLeaf(leaf, lower, upper, origin);
      if (inspected.tag === "compatible")
        return {
          tag: "one",
          value: inspected.value,
          driver: { mode: "Replay", leaves: driver.leaves.slice(1), cursor: driver.cursor + 1n },
          decision: leaf,
        };
      if (inspected.tag === "out-of-bounds")
        return {
          tag: "error",
          error: machineError(
            "ReplayValueOutOfBounds",
            expr([sym("Path"), gint(driver.cursor)]),
            expr([sym("Bounds"), gint(lower), gint(upper)]),
            expr([sym("Value"), gint(inspected.value)]),
          ),
        };
      if (inspected.tag === "metadata")
        return {
          tag: "error",
          error: machineError(
            "ReplayMismatch",
            expr([sym("Path"), gint(driver.cursor)]),
            expr([sym("ExpectedBounds"), gint(lower), gint(upper)]),
            expr([sym("ActualBounds"), inspected.bounds[0], inspected.bounds[1]]),
            expr([sym("Origins"), gint(origin), inspected.origin]),
          ),
        };
      return {
        tag: "error",
        error: machineError(
          "ReplayMismatch",
          expr([sym("Path"), gint(driver.cursor)]),
          expr([sym("Expected"), sym("IntDecision")]),
          expr([sym("Actual"), leaf]),
        ),
      };
    }
    case "ShrinkReplay": {
      let leaves = driver.leaves;
      let cursor = driver.cursor;
      while (leaves.length > 0) {
        const leaf = leaves[0]!;
        const rest = leaves.slice(1);
        const nextCursor = cursor + 1n;
        const inspected = inspectIntLeaf(leaf, lower, upper, origin);
        if (inspected.tag === "compatible")
          return {
            tag: "one",
            value: inspected.value,
            driver: { mode: "ShrinkReplay", leaves: rest, cursor: nextCursor },
            decision: leaf,
          };
        leaves = rest;
        cursor = nextCursor;
      }
      const value = origin < lower ? lower : origin > upper ? upper : origin;
      return {
        tag: "one",
        value,
        driver: { mode: "ShrinkReplay", leaves: [], cursor },
        decision: intDecisionAtom(lower, upper, origin, value),
      };
    }
    case "Exhaustive": {
      const span = upper - lower + 1n;
      const offset =
        driver.cursor < BigInt(driver.choices.length) ? driver.choices[Number(driver.cursor)]! : 0n;
      if (offset < 0n || offset >= span)
        return {
          tag: "error",
          error: machineError(
            "ExhaustiveResumeMismatch",
            expr([sym("Offset"), gint(offset)]),
            expr([sym("Bounds"), gint(lower), gint(upper)]),
          ),
        };
      const value = lower + offset;
      return {
        tag: "one",
        value,
        driver: {
          mode: "Exhaustive",
          choices: driver.choices,
          cursor: driver.cursor + 1n,
          frames: [expr([sym("ExhaustiveFrame"), gint(offset), gint(span)]), ...driver.frames],
        },
        decision: intDecisionAtom(lower, upper, origin, value),
      };
    }
    case "Bytes": {
      const span = upper - lower + 1n;
      let width = 1n;
      let capacity = 256n;
      while (capacity < span) {
        capacity *= 256n;
        width += 1n;
      }
      let raw = 0n;
      let cursor = driver.cursor;
      for (let remaining = width; remaining > 0n; remaining -= 1n) {
        if (cursor >= BigInt(driver.bytes.length))
          return {
            tag: "error",
            error: machineError(
              "BytesExhausted",
              expr([sym("Cursor"), gint(cursor)]),
              expr([sym("Remaining"), gint(remaining)]),
            ),
          };
        const byte = integralNumberValue(driver.bytes[Number(cursor)]!);
        if (byte === undefined)
          return {
            tag: "error",
            error: machineError(
              "MalformedByteRead",
              expr([sym("OperationResult"), driver.bytes[Number(cursor)]!]),
            ),
          };
        raw = raw * 256n + byte;
        cursor += 1n;
      }
      const value = lower + (raw % span);
      return {
        tag: "one",
        value,
        driver: { mode: "Bytes", bytes: driver.bytes, cursor },
        decision: intDecisionAtom(lower, upper, origin, value),
      };
    }
  }
}

function decodeFrames(atom: Atom): MachineFrame[] | Atom {
  const frames: MachineFrame[] = [];
  let cursor = atom;
  for (;;) {
    if (cursor.kind === "sym" && cursor.name === GFB_SYM.name) break;
    if (
      cursor.kind !== "expr" ||
      cursor.items.length !== 3 ||
      cursor.items[0]!.kind !== "sym" ||
      cursor.items[0]!.name !== GF_HEAD.name
    )
      return machineError("MalformedGrammarMachineState", expr([sym("Frames"), atom]));
    const frame = cursor.items[1]!;
    cursor = cursor.items[2]!;
    if (frame.kind !== "expr" || frame.items.length === 0 || frame.items[0]!.kind !== "sym")
      return machineError("MalformedGrammarMachineState", expr([sym("Frames"), atom]));
    const head = frame.items[0]!.name;
    if (head === "FPlan" && frame.items.length === 5 && frame.items[1]!.kind === "expr") {
      const cursorValue = integralNumberValue(frame.items[3]!);
      const size = integralNumberValue(frame.items[4]!);
      if (cursorValue === undefined || size === undefined)
        return machineError("MalformedGrammarMachineState", expr([sym("Frames"), atom]));
      frames.push({
        tag: "plan",
        instrs: frame.items[1]!.items,
        cursor: Number(cursorValue),
        size,
      });
      continue;
    }
    if (head === "FExpr" && frame.items.length === 4) {
      const arity = integralNumberValue(frame.items[1]!);
      const depth = integralNumberValue(frame.items[3]!);
      if (arity === undefined || depth === undefined)
        return machineError("MalformedGrammarMachineState", expr([sym("Frames"), atom]));
      frames.push({ tag: "expr", arity: Number(arity), depth: Number(depth) });
      continue;
    }
    if (head === "FRef" && frame.items.length === 2) {
      const target = unquote(frame.items[1]!);
      if (target === undefined)
        return machineError("MalformedGrammarMachineState", expr([sym("Frames"), atom]));
      frames.push({ tag: "ref", target });
      continue;
    }
    if (head === "FProd" && frame.items.length === 5) {
      const target = unquote(frame.items[1]!);
      const position = integralNumberValue(frame.items[3]!);
      if (target === undefined || position === undefined)
        return machineError("MalformedGrammarMachineState", expr([sym("Frames"), atom]));
      frames.push({
        tag: "prod",
        target,
        productionIndex: frame.items[2]!,
        position: Number(position),
        choiceTree: frame.items[4]!,
      });
      continue;
    }
    if (head === "FBind" && frame.items.length === 4) {
      const sort = unquote(frame.items[1]!);
      const bindingId = integralNumberValue(frame.items[2]!);
      if (sort === undefined || bindingId === undefined)
        return machineError("MalformedGrammarMachineState", expr([sym("Frames"), atom]));
      frames.push({ tag: "bind", sort, bindingId, variable: frame.items[3]! });
      continue;
    }
    if (head === "FScoped" && frame.items.length === 2) {
      frames.push({ tag: "scoped", added: frame.items[1]! });
      continue;
    }
    if (head === "FScope" && frame.items.length === 2 && frame.items[1]!.kind === "expr") {
      frames.push({ tag: "scope", saved: frame.items[1]!.items });
      continue;
    }
    return machineError("MalformedGrammarMachineState", expr([sym("Frames"), atom]));
  }
  return frames;
}

function unquote(atom: Atom): Atom | undefined {
  if (
    atom.kind === "expr" &&
    atom.items.length === 2 &&
    atom.items[0]!.kind === "sym" &&
    atom.items[0]!.name === QUOTE_HEAD.name
  )
    return atom.items[1]!;
  return undefined;
}

function encodeFrames(frames: readonly MachineFrame[]): Atom {
  let out: Atom = GFB_SYM;
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const frame = frames[index]!;
    let encoded: Atom;
    switch (frame.tag) {
      case "plan":
        encoded = expr([
          sym("FPlan"),
          expr([...frame.instrs]),
          gint(BigInt(frame.instrs.length)),
          gint(BigInt(frame.cursor)),
          gint(frame.size),
        ]);
        break;
      case "expr":
        encoded = expr([
          sym("FExpr"),
          gint(BigInt(frame.arity)),
          gint(BigInt(frame.depth)),
          gint(BigInt(frame.depth)),
        ]);
        break;
      case "ref":
        encoded = expr([sym("FRef"), quoteAtom(frame.target)]);
        break;
      case "prod":
        encoded = expr([
          sym("FProd"),
          quoteAtom(frame.target),
          frame.productionIndex,
          gint(BigInt(frame.position)),
          frame.choiceTree,
        ]);
        break;
      case "bind":
        encoded = expr([
          sym("FBind"),
          quoteAtom(frame.sort),
          gint(frame.bindingId),
          frame.variable,
        ]);
        break;
      case "scoped":
        encoded = expr([sym("FScoped"), frame.added]);
        break;
      case "scope":
        encoded = expr([sym("FScope"), expr([...frame.saved])]);
        break;
    }
    out = expr([GF_HEAD, encoded, out]);
  }
  return out;
}

function decodeStack(atom: Atom): Atom[] | Atom {
  const out: Atom[] = [];
  let cursor = atom;
  for (;;) {
    if (cursor.kind === "sym" && cursor.name === FUZZ_STACK_BOTTOM_SYM.name) break;
    if (
      cursor.kind !== "expr" ||
      cursor.items.length !== 3 ||
      cursor.items[0]!.kind !== "sym" ||
      cursor.items[0]!.name !== FUZZ_STACK_HEAD.name
    )
      return machineError("MalformedGrammarMachineState", expr([sym("Stack"), atom]));
    out.push(cursor.items[1]!);
    cursor = cursor.items[2]!;
  }
  out.reverse();
  return out;
}

function encodeStack(items: readonly Atom[]): Atom {
  let out: Atom = FUZZ_STACK_BOTTOM_SYM;
  for (const item of items) out = expr([FUZZ_STACK_HEAD, item, out]);
  return out;
}

function productionsOfSource(source: Atom): Atom | undefined {
  if (
    source.kind === "expr" &&
    source.items.length === 3 &&
    source.items[0]!.kind === "sym" &&
    (source.items[0]!.name === "StaticGrammar" || source.items[0]!.name === "StaticTypeGrammar") &&
    source.items[2]!.kind === "expr"
  )
    return source.items[2]!;
  return undefined;
}

function encodeMachineState(state: MachineState): Atom {
  const shared = [
    state.source,
    encodeFrames(state.frames),
    encodeStack(state.values),
    gint(BigInt(state.values.length)),
    encodeStack(state.trees),
    gint(BigInt(state.trees.length)),
  ];
  if (state.cut === undefined)
    return expr([
      GEN_RUN_HEAD,
      ...shared,
      expr([...state.scope]),
      gint(state.nextId),
      encodeDriver(state.driver),
    ]);
  return expr([
    GEN_CUT_HEAD,
    ...shared,
    state.cut.reason,
    state.cut.tree,
    encodeDriver(state.driver),
  ]);
}

function decodeMachineState(atom: Atom): MachineState | Atom {
  if (atom.kind !== "expr" || atom.items.length === 0 || atom.items[0]!.kind !== "sym")
    return machineError("MalformedGrammarMachineState", expr([sym("Value"), atom]));
  const head = atom.items[0]!.name;
  const running = head === GEN_RUN_HEAD.name;
  if ((running && atom.items.length !== 10) || (!running && head !== GEN_CUT_HEAD.name))
    return machineError("MalformedGrammarMachineState", expr([sym("Value"), atom]));
  if (!running && atom.items.length !== 10)
    return machineError("MalformedGrammarMachineState", expr([sym("Value"), atom]));
  const source = atom.items[1]!;
  const productions = productionsOfSource(source);
  if (productions === undefined)
    return machineError("MalformedGrammarSource", expr([sym("Value"), source]));
  const frames = decodeFrames(atom.items[2]!);
  if (!Array.isArray(frames)) return frames;
  const values = decodeStack(atom.items[3]!);
  if (!Array.isArray(values)) return values;
  const trees = decodeStack(atom.items[5]!);
  if (!Array.isArray(trees)) return trees;
  const driver = decodeDriver(atom.items[9]!);
  if (!("mode" in driver)) return driver;
  if (running) {
    const scopeAtom = atom.items[7]!;
    const nextId = integralNumberValue(atom.items[8]!);
    if (scopeAtom.kind !== "expr" || nextId === undefined)
      return machineError("MalformedGrammarMachineState", expr([sym("Value"), atom]));
    return {
      source,
      productions,
      frames,
      values,
      trees,
      scope: [...scopeAtom.items],
      nextId,
      driver,
      cut: undefined,
    };
  }
  return {
    source,
    productions,
    frames,
    values,
    trees,
    scope: [],
    nextId: 0n,
    driver,
    cut: { reason: atom.items[7]!, tree: atom.items[8]! },
  };
}

type StepResult =
  | { readonly tag: "continue" }
  | { readonly tag: "outcome"; readonly outcome: MachineOutcome };

function doneOutcome(result: Atom): StepResult {
  return { tag: "outcome", outcome: { tag: "done", result } };
}

function pushResult(state: MachineState, value: Atom, tree: Atom): void {
  state.values.push(value);
  state.trees.push(tree);
}

function scopeValueMarkers(scope: readonly Atom[], sort: Atom): Atom[] | Atom {
  const out: Atom[] = [];
  for (const binding of scope) {
    if (
      binding.kind !== "expr" ||
      binding.items.length !== 3 ||
      binding.items[0]!.kind !== "sym" ||
      binding.items[0]!.name !== "GrammarBinding"
    )
      continue;
    const boundSort = unquote(binding.items[1]!);
    if (boundSort === undefined || !atomEq(boundSort, sort)) continue;
    const id = integralNumberValue(binding.items[2]!);
    if (id === undefined || id < 0n)
      return machineError("MalformedGrammarMachineState", expr([sym("Scope"), binding]));
    out.push(
      gnd(
        { g: "ext", kind: FUZZ_VARIABLE_MARKER_KIND, id: id.toString() },
        FUZZ_VARIABLE_MARKER_TYPE,
      ),
    );
  }
  return out;
}

function containsMarkerValue(root: Atom): boolean {
  const pending: Atom[] = [root];
  while (pending.length > 0) {
    const atom = pending.pop()!;
    if (
      atom.kind === "gnd" &&
      atom.value.g === "ext" &&
      atom.value.kind === FUZZ_VARIABLE_MARKER_KIND
    )
      return true;
    if (atom.kind === "expr")
      for (let index = atom.items.length - 1; index >= 0; index -= 1)
        pending.push(atom.items[index]!);
  }
  return false;
}

function fieldDecision(generator: Atom, child: Atom): Atom {
  return expr([
    DECISION_HEAD,
    sym("GrammarField"),
    expr([sym("Generator"), generator]),
    expr([]),
    expr([child]),
  ]);
}

function suspend(state: MachineState, generator: Atom, size: bigint): StepResult {
  const request = expr([
    EVALUATE_GENERATOR_HEAD,
    generator,
    encodeDriver(state.driver),
    gint(size),
  ]);
  return {
    tag: "outcome",
    outcome: { tag: "need", state: encodeMachineState(state), request },
  };
}

// Applies one machine step in place. Mirrors the specification machine rule for rule.
function stepMachine(state: MachineState): StepResult {
  if (state.cut !== undefined) {
    const frame = state.frames.pop();
    if (frame === undefined)
      return doneOutcome(
        expr([
          FUZZ_GENERATION_DISCARD_HEAD,
          state.cut.reason,
          encodeDriver(state.driver),
          state.cut.tree,
        ]),
      );
    switch (frame.tag) {
      case "plan":
        return { tag: "continue" };
      case "expr": {
        const generated = state.trees.length - frame.depth;
        const taken = state.trees.splice(frame.depth, generated);
        state.values.splice(frame.depth, generated);
        state.cut = {
          reason: state.cut.reason,
          tree: expr([
            DECISION_HEAD,
            sym("GrammarExpression"),
            expr([sym("Arity"), gint(BigInt(frame.arity))]),
            expr([sym("Generated"), gint(BigInt(generated + 1))]),
            expr([...taken, state.cut.tree]),
          ]),
        };
        return { tag: "continue" };
      }
      case "ref":
        state.cut = {
          reason: state.cut.reason,
          tree: expr([
            DECISION_HEAD,
            sym("GrammarRef"),
            expr([sym("Target"), quoteAtom(frame.target)]),
            expr([]),
            expr([state.cut.tree]),
          ]),
        };
        return { tag: "continue" };
      case "prod":
        state.cut = {
          reason: state.cut.reason,
          tree: expr([
            DECISION_HEAD,
            sym("GrammarProduction"),
            expr([sym("Target"), quoteAtom(frame.target)]),
            expr([sym("ProductionIndex"), frame.productionIndex, gint(BigInt(frame.position))]),
            expr([frame.choiceTree, state.cut.tree]),
          ]),
        };
        return { tag: "continue" };
      case "bind":
        state.cut = {
          reason: state.cut.reason,
          tree: expr([
            DECISION_HEAD,
            sym("GrammarBind"),
            expr([sym("Sort"), quoteAtom(frame.sort)]),
            expr([sym("BindingId"), gint(frame.bindingId)]),
            expr([state.cut.tree]),
          ]),
        };
        return { tag: "continue" };
      case "scoped":
        state.cut = {
          reason: state.cut.reason,
          tree: expr([
            DECISION_HEAD,
            sym("GrammarScoped"),
            expr([sym("Bindings"), frame.added]),
            expr([]),
            expr([state.cut.tree]),
          ]),
        };
        return { tag: "continue" };
      case "scope":
        return { tag: "continue" };
    }
  }

  const frame = state.frames[state.frames.length - 1];
  if (frame === undefined) {
    if (state.values.length !== 1 || state.trees.length !== 1)
      return doneOutcome(
        machineError("MalformedGrammarMachineState", expr([sym("State"), sym("stacks")])),
      );
    return doneOutcome(
      expr([
        sym("GrammarResult"),
        state.values[0]!,
        encodeDriver(state.driver),
        gint(state.nextId),
        state.trees[0]!,
      ]),
    );
  }

  if (frame.tag !== "plan") {
    state.frames.pop();
    switch (frame.tag) {
      case "scope":
        state.scope = [...frame.saved];
        return { tag: "continue" };
      case "ref": {
        const tree = state.trees.pop()!;
        state.trees.push(
          expr([
            DECISION_HEAD,
            sym("GrammarRef"),
            expr([sym("Target"), quoteAtom(frame.target)]),
            expr([]),
            expr([tree]),
          ]),
        );
        return { tag: "continue" };
      }
      case "prod": {
        const tree = state.trees.pop()!;
        state.trees.push(
          expr([
            DECISION_HEAD,
            sym("GrammarProduction"),
            expr([sym("Target"), quoteAtom(frame.target)]),
            expr([sym("ProductionIndex"), frame.productionIndex, gint(BigInt(frame.position))]),
            expr([frame.choiceTree, tree]),
          ]),
        );
        return { tag: "continue" };
      }
      case "bind": {
        const body = state.values.pop()!;
        const tree = state.trees.pop()!;
        state.values.push(expr([frame.variable, body]));
        state.trees.push(
          expr([
            DECISION_HEAD,
            sym("GrammarBind"),
            expr([sym("Sort"), quoteAtom(frame.sort)]),
            expr([sym("BindingId"), gint(frame.bindingId)]),
            expr([tree]),
          ]),
        );
        return { tag: "continue" };
      }
      case "scoped": {
        const tree = state.trees.pop()!;
        state.trees.push(
          expr([
            DECISION_HEAD,
            sym("GrammarScoped"),
            expr([sym("Bindings"), frame.added]),
            expr([]),
            expr([tree]),
          ]),
        );
        return { tag: "continue" };
      }
      case "expr":
        return doneOutcome(
          machineError("MalformedGrammarMachineState", expr([sym("Frames"), sym("FExpr")])),
        );
    }
  }

  if (frame.cursor >= frame.instrs.length) {
    state.frames.pop();
    return { tag: "continue" };
  }
  const instr = frame.instrs[frame.cursor]!;
  frame.cursor += 1;
  const size = frame.size;
  if (instr.kind !== "expr" || instr.items.length === 0 || instr.items[0]!.kind !== "sym")
    return doneOutcome(machineError("MalformedGrammarInstruction", expr([sym("Value"), instr])));
  const op = instr.items[0]!.name;

  if (op === "GILit" && instr.items.length === 2) {
    const value = unquote(instr.items[1]!);
    if (value === undefined)
      return doneOutcome(machineError("MalformedGrammarInstruction", expr([sym("Value"), instr])));
    pushResult(
      state,
      value,
      expr([
        DECISION_HEAD,
        sym("GrammarLiteral"),
        expr([]),
        expr([sym("Value"), quoteAtom(value)]),
        expr([]),
      ]),
    );
    return { tag: "continue" };
  }
  if (op === "GIField" && instr.items.length === 2) return suspend(state, instr.items[1]!, size);
  if (op === "GIRef" && instr.items.length === 4) {
    const target = unquote(instr.items[1]!);
    const ordinal = integralNumberValue(instr.items[2]!);
    const total = integralNumberValue(instr.items[3]!);
    if (target === undefined || ordinal === undefined || total === undefined)
      return doneOutcome(machineError("MalformedGrammarInstruction", expr([sym("Value"), instr])));
    if (size <= 0n)
      return doneOutcome(
        machineError(
          "GrammarDepthExhausted",
          expr([sym("Target"), quoteAtom(target)]),
          expr([sym("Size"), gint(size)]),
        ),
      );
    if (total <= 0n || ordinal < 0n || ordinal >= total)
      return doneOutcome(
        machineError(
          "MalformedIndexedGrammarReference",
          expr([sym("Ordinal"), gint(ordinal)]),
          expr([sym("Total"), gint(total)]),
        ),
      );
    const childSize = referenceChildSize(size, ordinal, total);
    state.frames.push({ tag: "ref", target });
    return enterNonterminal(state, target, childSize);
  }
  if (op === "GIFresh" && instr.items.length === 2) {
    const sort = unquote(instr.items[1]!);
    if (sort === undefined)
      return doneOutcome(machineError("MalformedGrammarInstruction", expr([sym("Value"), instr])));
    const marker = gnd(
      { g: "ext", kind: FUZZ_VARIABLE_MARKER_KIND, id: state.nextId.toString() },
      FUZZ_VARIABLE_MARKER_TYPE,
    );
    pushResult(
      state,
      marker,
      expr([
        DECISION_HEAD,
        sym("GrammarFresh"),
        expr([sym("Sort"), quoteAtom(sort)]),
        expr([sym("BindingId"), gint(state.nextId)]),
        expr([]),
      ]),
    );
    state.nextId += 1n;
    return { tag: "continue" };
  }
  if (op === "GIUse" && instr.items.length === 2) {
    const sort = unquote(instr.items[1]!);
    if (sort === undefined)
      return doneOutcome(machineError("MalformedGrammarInstruction", expr([sym("Value"), instr])));
    const markers = scopeValueMarkers(state.scope, sort);
    if (!Array.isArray(markers)) return doneOutcome(markers);
    if (markers.length === 0)
      return doneOutcome(machineError("UnboundGrammarUse", expr([sym("Sort"), quoteAtom(sort)])));
    return suspend(state, expr([sym("GenElement"), expr(markers)]), size);
  }
  if (op === "GIBind" && instr.items.length === 3 && instr.items[2]!.kind === "expr") {
    const sort = unquote(instr.items[1]!);
    if (sort === undefined)
      return doneOutcome(machineError("MalformedGrammarInstruction", expr([sym("Value"), instr])));
    const variable = gnd(
      { g: "ext", kind: FUZZ_VARIABLE_MARKER_KIND, id: state.nextId.toString() },
      FUZZ_VARIABLE_MARKER_TYPE,
    );
    state.frames.push({ tag: "scope", saved: [...state.scope] });
    state.frames.push({ tag: "bind", sort, bindingId: state.nextId, variable });
    state.frames.push({ tag: "plan", instrs: instr.items[2]!.items, cursor: 0, size });
    state.scope = [
      expr([sym("GrammarBinding"), quoteAtom(sort), gint(state.nextId)]),
      ...state.scope,
    ];
    state.nextId += 1n;
    return { tag: "continue" };
  }
  if (
    op === "GIScoped" &&
    instr.items.length === 5 &&
    instr.items[1]!.kind === "expr" &&
    instr.items[4]!.kind === "expr"
  ) {
    const added = instr.items[1]!;
    const minimumNextId = integralNumberValue(instr.items[2]!);
    const raw = unquote(instr.items[3]!);
    if (minimumNextId === undefined || raw === undefined)
      return doneOutcome(machineError("MalformedGrammarInstruction", expr([sym("Value"), instr])));
    for (const binding of added.items) {
      if (binding.kind !== "expr" || binding.items.length !== 3) continue;
      const id = binding.items[2]!;
      for (const existing of state.scope)
        if (
          existing.kind === "expr" &&
          existing.items.length === 3 &&
          atomEq(existing.items[2]!, id)
        )
          return doneOutcome(
            machineError("DuplicateGrammarBindingId", expr([sym("Bindings"), raw])),
          );
    }
    state.frames.push({ tag: "scope", saved: [...state.scope] });
    state.frames.push({ tag: "scoped", added });
    state.frames.push({ tag: "plan", instrs: instr.items[4]!.items, cursor: 0, size });
    state.scope = [...added.items, ...state.scope];
    if (minimumNextId > state.nextId) state.nextId = minimumNextId;
    return { tag: "continue" };
  }
  if (op === "GIExprEnter" && instr.items.length === 2) {
    const arity = integralNumberValue(instr.items[1]!);
    if (arity === undefined)
      return doneOutcome(machineError("MalformedGrammarInstruction", expr([sym("Value"), instr])));
    const plan = state.frames.pop()!;
    state.frames.push({ tag: "expr", arity: Number(arity), depth: state.trees.length });
    state.frames.push(plan);
    return { tag: "continue" };
  }
  if (op === "GIExprBuild" && instr.items.length === 1) {
    const plan = state.frames.pop()!;
    const exprFrame = state.frames.pop();
    if (exprFrame === undefined || exprFrame.tag !== "expr")
      return doneOutcome(
        machineError("MalformedGrammarMachineState", expr([sym("Frames"), sym("GIExprBuild")])),
      );
    state.frames.push(plan);
    const values = state.values.splice(state.values.length - exprFrame.arity, exprFrame.arity);
    const trees = state.trees.splice(state.trees.length - exprFrame.arity, exprFrame.arity);
    pushResult(
      state,
      expr(values),
      expr([
        DECISION_HEAD,
        sym("GrammarExpression"),
        expr([sym("Arity"), gint(BigInt(exprFrame.arity))]),
        expr([]),
        expr(trees),
      ]),
    );
    return { tag: "continue" };
  }
  return doneOutcome(machineError("MalformedGrammarInstruction", expr([sym("Value"), instr])));
}

function enterNonterminal(state: MachineState, target: Atom, size: bigint): StepResult {
  const eligibleAtom = eligibleListForMachine(state.productions, target, state.scope, size);
  if (
    eligibleAtom.kind !== "expr" ||
    eligibleAtom.items.length !== 2 ||
    eligibleAtom.items[0]!.kind !== "sym" ||
    eligibleAtom.items[0]!.name !== "EligibleGrammarProductions" ||
    eligibleAtom.items[1]!.kind !== "expr"
  ) {
    if (
      eligibleAtom.kind === "expr" &&
      eligibleAtom.items.length === 2 &&
      eligibleAtom.items[0]!.kind === "sym" &&
      eligibleAtom.items[0]!.name === "FitDuplicateGrammarBindingId"
    ) {
      const raw = unquote(eligibleAtom.items[1]!);
      return doneOutcome(
        machineError(
          "DuplicateGrammarBindingId",
          expr([sym("Bindings"), raw ?? eligibleAtom.items[1]!]),
        ),
      );
    }
    return doneOutcome(machineError("KernelError", expr([sym("OperationResult"), eligibleAtom])));
  }
  const eligible = eligibleAtom.items[1]!.items;
  if (eligible.length === 0) {
    state.cut = {
      reason: expr([
        sym("NoEligibleGrammarProduction"),
        expr([sym("Target"), quoteAtom(target)]),
        expr([sym("Size"), gint(size)]),
      ]),
      tree: expr([
        DECISION_HEAD,
        sym("GrammarUnavailable"),
        expr([sym("Target"), quoteAtom(target)]),
        expr([sym("Size"), gint(size)]),
        expr([]),
      ]),
    };
    return { tag: "continue" };
  }

  const count = BigInt(eligible.length);
  let choice: IntChoice;
  if (state.driver.mode === "Random") {
    let total = 0n;
    for (const production of eligible) {
      const weight = integralNumberValue(
        (production as Extract<Atom, { readonly kind: "expr" }>).items[2]!,
      );
      total += weight ?? 0n;
    }
    const [ticket, nextRng] = drawIntFromState(state.driver.rng, 1n, total);
    let remaining = ticket;
    let position = 0n;
    for (const production of eligible) {
      const weight =
        integralNumberValue((production as Extract<Atom, { readonly kind: "expr" }>).items[2]!) ??
        0n;
      if (remaining <= weight) break;
      remaining -= weight;
      position += 1n;
    }
    choice = {
      tag: "one",
      value: position,
      driver: { mode: "Random", rng: nextRng },
      decision: intDecisionAtom(0n, count - 1n, 0n, position),
    };
  } else if (state.driver.mode === "Edge") {
    const position = state.driver.index % count;
    choice = {
      tag: "one",
      value: position,
      driver: { mode: "Edge", index: state.driver.index + 1n },
      decision: intDecisionAtom(0n, count - 1n, 0n, position),
    };
  } else {
    choice = driverInt(state.driver, 0n, count - 1n, 0n);
  }

  if (choice.tag === "error") return doneOutcome(choice.error);
  const applyChoice = (
    target2: MachineState,
    branch: { value: bigint; driver: MachineDriver; decision: Atom },
  ): StepResult => {
    target2.driver = branch.driver;
    const production = eligible[Number(branch.value)]!;
    if (
      production.kind !== "expr" ||
      production.items.length !== 5 ||
      production.items[4]!.kind !== "expr" ||
      production.items[4]!.items.length !== 2
    )
      return doneOutcome(
        machineError(
          "MalformedSelectedGrammarProduction",
          expr([sym("Target"), quoteAtom(target)]),
          expr([sym("Production"), production]),
        ),
      );
    const template = production.items[4]!.items[1]!;
    const planned = compileTemplatePlanCached(template);
    if (isErrorAtom(planned))
      return doneOutcome(machineError("KernelError", expr([sym("OperationResult"), planned])));
    target2.frames.push({
      tag: "prod",
      target,
      productionIndex: production.items[1]!,
      position: Number(branch.value),
      choiceTree: branch.decision,
    });
    target2.frames.push({ tag: "plan", instrs: planned, cursor: 0, size });
    return { tag: "continue" };
  };

  return applyChoice(state, choice);
}

function compileTemplatePlanCached(template: Atom): readonly Atom[] | Atom {
  const cached = templatePlanCache.get(template);
  if (cached !== undefined) {
    const body = (cached as Extract<Atom, { readonly kind: "expr" }>).items[1]!;
    return (body as Extract<Atom, { readonly kind: "expr" }>).items;
  }
  const instructions = compileTemplatePlan(template);
  if (!Array.isArray(instructions)) return instructions;
  const plan = expr([GRAMMAR_TEMPLATE_PLAN_HEAD, expr(instructions)]);
  templatePlanCache.set(template, plan);
  return instructions;
}

// Shared with the eligibility operation: identical fit semantics and memoisation.
function eligibleListForMachine(
  productions: Atom,
  target: Atom,
  scope: readonly Atom[],
  size: bigint,
): Atom {
  const looked = grammarEligibleProductions([
    productions,
    quoteAtom(target),
    expr([...scope]),
    gint(size),
  ]);
  if (looked.tag !== "ok" || looked.results.length !== 1)
    return kernelError(
      "InvalidGrammarEligibility",
      expr([sym("Operation"), sym("_fuzz-grammar-machine-op")]),
      sym("EligibilityFailed"),
    );
  return looked.results[0]!;
}

function runMachineToOutcome(state: MachineState): MachineOutcome {
  for (;;) {
    const stepped = stepMachine(state);
    if (stepped.tag === "outcome") return stepped.outcome;
  }
}

const grammarMachineOp: GroundFn = (args) => {
  if (args.length !== 1) return arityError("_fuzz-grammar-machine-op", 1, args.length);
  const input = args[0]!;
  if (input.kind !== "expr" || input.items.length === 0 || input.items[0]!.kind !== "sym")
    return operationError(
      "InvalidGrammarMachineInput",
      "_fuzz-grammar-machine-op",
      "ExpectedExpression",
    );
  const head = input.items[0]!.name;

  let state: MachineState;
  if (head === MACHINE_START_HEAD.name && input.items.length === 6) {
    const source = input.items[1]!;
    const target = unquote(input.items[2]!);
    const scopeAtom = input.items[3]!;
    const nextId = integralNumberValue(input.items[4]!);
    if (target === undefined || scopeAtom.kind !== "expr" || nextId === undefined)
      return operationError(
        "InvalidGrammarMachineInput",
        "_fuzz-grammar-machine-op",
        "MalformedStart",
      );
    const request = input.items[5]!;
    if (
      request.kind !== "expr" ||
      request.items.length !== 3 ||
      request.items[0]!.kind !== "sym" ||
      request.items[0]!.name !== "WithDriver"
    )
      return operationError(
        "InvalidGrammarMachineInput",
        "_fuzz-grammar-machine-op",
        "MalformedStart",
      );
    const driver = decodeDriver(request.items[1]!);
    if (!("mode" in driver)) return ok(expr([MACHINE_DONE_HEAD, driver]));
    const size = integralNumberValue(request.items[2]!);
    if (size === undefined)
      return operationError(
        "InvalidGrammarMachineInput",
        "_fuzz-grammar-machine-op",
        "MalformedStart",
      );
    const productions = productionsOfSource(source);
    if (productions === undefined)
      return ok(
        expr([
          MACHINE_DONE_HEAD,
          machineError("MalformedGrammarSource", expr([sym("Value"), source])),
        ]),
      );
    state = {
      source,
      productions,
      frames: [],
      values: [],
      trees: [],
      scope: [...scopeAtom.items],
      nextId,
      driver,
      cut: undefined,
    };
    const entered = enterNonterminal(state, target, size);
    if (entered.tag === "outcome")
      return {
        tag: "ok",
        results: [outcomeAtom(entered.outcome)],
      };
  } else if (head === MACHINE_RESUME_HEAD.name && input.items.length === 3) {
    const decoded = decodeMachineState(input.items[1]!);
    if (!("frames" in decoded)) return ok(expr([MACHINE_DONE_HEAD, decoded]));
    state = decoded;
    const sample = input.items[2]!;
    const applied = applySubResult(state, sample);
    if (applied !== undefined) return ok(expr([MACHINE_DONE_HEAD, applied]));
  } else {
    return operationError(
      "InvalidGrammarMachineInput",
      "_fuzz-grammar-machine-op",
      "UnknownRequest",
    );
  }

  return ok(outcomeAtom(runMachineToOutcome(state)));
};

function outcomeAtom(outcome: MachineOutcome): Atom {
  if (outcome.tag === "done") return expr([MACHINE_DONE_HEAD, outcome.result]);
  return expr([MACHINE_NEED_HEAD, outcome.state, outcome.request]);
}

// Consumes the trampoline's answer to an `EvaluateGenerator` request: the sub-generation ran the
// suspended field or `Use` element choice, so its sample becomes the next pushed value (with the
// forged-marker check for fields) and its driver becomes the machine's driver. The suspension
// site is identified by the instruction just before the plan cursor.
function applySubResult(state: MachineState, sample: Atom): Atom | undefined {
  const frame = state.frames[state.frames.length - 1];
  if (frame === undefined || frame.tag !== "plan" || frame.cursor === 0)
    return machineError("MalformedGrammarMachineState", expr([sym("Resume"), sym("frame")]));
  const instr = frame.instrs[frame.cursor - 1]!;
  if (instr.kind !== "expr" || instr.items.length !== 2 || instr.items[0]!.kind !== "sym")
    return machineError("MalformedGrammarMachineState", expr([sym("Resume"), sym("instruction")]));
  const instrHead = instr.items[0]!.name;
  const isField = instrHead === "GIField";
  const isUse = instrHead === "GIUse";
  if (!isField && !isUse)
    return machineError("MalformedGrammarMachineState", expr([sym("Resume"), sym("instruction")]));

  if (
    sample.kind === "expr" &&
    sample.items.length === 4 &&
    sample.items[0]!.kind === "sym" &&
    sample.items[0]!.name === FUZZ_SAMPLE_HEAD.name
  ) {
    const value = sample.items[1]!;
    const nextDriver = decodeDriver(sample.items[2]!);
    if (!("mode" in nextDriver)) return nextDriver;
    const tree = sample.items[3]!;
    if (isField) {
      const generator = instr.items[1]!;
      if (containsMarkerValue(value))
        return machineError(
          "ForgedGrammarVariableMarker",
          expr([sym("Generator"), generator]),
          expr([sym("Value"), value]),
        );
      state.driver = nextDriver;
      pushResult(state, value, fieldDecision(generator, tree));
      return undefined;
    }
    const sort = unquote(instr.items[1]!)!;
    state.driver = nextDriver;
    pushResult(
      state,
      value,
      expr([
        DECISION_HEAD,
        sym("GrammarUse"),
        expr([sym("Sort"), quoteAtom(sort)]),
        expr([]),
        expr([tree]),
      ]),
    );
    return undefined;
  }
  if (
    sample.kind === "expr" &&
    sample.items.length === 4 &&
    sample.items[0]!.kind === "sym" &&
    sample.items[0]!.name === FUZZ_GENERATION_DISCARD_HEAD.name
  ) {
    if (!isField)
      return machineError(
        "MalformedGrammarUseResult",
        expr([sym("Sort"), instr.items[1]!]),
        expr([sym("Value"), sample]),
      );
    const nextDriver = decodeDriver(sample.items[2]!);
    if (!("mode" in nextDriver)) return nextDriver;
    state.driver = nextDriver;
    state.cut = {
      reason: sample.items[1]!,
      tree: fieldDecision(instr.items[1]!, sample.items[3]!),
    };
    return undefined;
  }
  if (
    sample.kind === "expr" &&
    sample.items.length >= 1 &&
    sample.items[0]!.kind === "sym" &&
    sample.items[0]!.name === FUZZ_GENERATION_ERROR_HEAD.name
  )
    return sample;
  return isField
    ? machineError(
        "MalformedGrammarFieldResult",
        expr([sym("Generator"), instr.items[1]!]),
        expr([sym("Value"), sample]),
      )
    : machineError(
        "MalformedGrammarUseResult",
        expr([sym("Sort"), instr.items[1]!]),
        expr([sym("Value"), sample]),
      );
}

// Distinct production targets in first-occurrence order, and reference validation against
// them — both one pass over raw syntax.
const grammarTargetsOp: GroundFn = (args) => {
  if (args.length !== 1) return arityError("_fuzz-grammar-targets-op", 1, args.length);
  const productions = args[0]!;
  if (productions.kind !== "expr")
    return operationError(
      "InvalidGrammarProductions",
      "_fuzz-grammar-targets-op",
      "ExpectedExpression",
    );
  const seen = new Set<string>();
  const out: Atom[] = [];
  for (const production of productions.items) {
    if (
      production.kind !== "expr" ||
      production.items.length !== 5 ||
      production.items[3]!.kind !== "expr" ||
      production.items[3]!.items.length !== 2
    )
      return operationError(
        "InvalidGrammarProductions",
        "_fuzz-grammar-targets-op",
        "MalformedProduction",
      );
    const target = production.items[3]!.items[1]!;
    const key = structuralAtomKey(target, "Exact");
    if (!key.ok) return ok(key.reason);
    if (seen.has(key.key)) continue;
    seen.add(key.key);
    out.push(quoteAtom(target));
  }
  return ok(expr([sym("GrammarTargets"), expr(out)]));
};

const grammarValidateReferencesOp: GroundFn = (args) => {
  if (args.length !== 2) return arityError("_fuzz-grammar-validate-references-op", 2, args.length);
  const [productions, targets] = args;
  if (productions!.kind !== "expr" || targets!.kind !== "expr")
    return operationError(
      "InvalidGrammarReferences",
      "_fuzz-grammar-validate-references-op",
      "ExpectedExpressions",
    );
  const known = new Set<string>();
  for (const quoted of targets!.items) {
    const target = unquote(quoted);
    if (target === undefined)
      return operationError(
        "InvalidGrammarReferences",
        "_fuzz-grammar-validate-references-op",
        "MalformedTarget",
      );
    const key = structuralAtomKey(target, "Exact");
    if (!key.ok) return ok(key.reason);
    known.add(key.key);
  }
  for (const production of productions!.items) {
    if (
      production.kind !== "expr" ||
      production.items.length !== 5 ||
      production.items[4]!.kind !== "expr" ||
      production.items[4]!.items.length !== 2
    )
      return operationError(
        "InvalidGrammarReferences",
        "_fuzz-grammar-validate-references-op",
        "MalformedProduction",
      );
    for (const referenced of templateReferenceTargetAtoms(production.items[4]!.items[1]!)) {
      const key = structuralAtomKey(referenced, "Exact");
      if (!key.ok) return ok(key.reason);
      if (!known.has(key.key))
        return ok(expr([sym("GrammarMissingReference"), quoteAtom(referenced)]));
    }
  }
  return ok(expr([sym("ValidGrammarReferences")]));
};

// Flattens a nested FuzzStack (top = most recently pushed) into a flat expression in push
// order — the accumulator finisher for bare-tail loops that build lists.
const fuzzStackToExpression: GroundFn = (args) => {
  if (args.length !== 1) return arityError("_fuzz-stack-to-expression", 1, args.length);
  const items = decodeStack(args[0]!);
  if (isErrorAtom(items))
    return operationError("InvalidStackTake", "_fuzz-stack-to-expression", "MalformedStack");
  return ok(expr(items));
};

// ---- productivity worklist support ----
// Which productions reference a target: the worklist fixed point re-analyzes exactly the
// dependents of a target whose alternatives changed, instead of restarting a full walk.
// Indexed once per productions atom.
const productionDependentsCache = new WeakMap<Atom, Map<string, Atom>>();

function templateReferenceTargetAtoms(template: Atom): Atom[] {
  const out: Atom[] = [];
  const pending: Atom[] = [template];
  while (pending.length > 0) {
    const atom = pending.pop()!;
    if (atom.kind === "expr" && atom.items.length > 0 && atom.items[0]!.kind === "sym") {
      const head = atom.items[0]!.name;
      if (head === "Ref" && atom.items.length === 2) {
        out.push(atom.items[1]!);
        continue;
      }
      if (head === GRAMMAR_INDEXED_REFERENCE_HEAD.name && atom.items.length === 4) {
        out.push(atom.items[1]!);
        continue;
      }
    }
    const indices = grammarTemplateChildIndices(atom);
    for (let index = indices.length - 1; index >= 0; index -= 1)
      pending.push((atom as Extract<Atom, { readonly kind: "expr" }>).items[indices[index]!]!);
  }
  return out;
}

const grammarDependentsOf: GroundFn = (args) => {
  const parsed = parseProductionsTargetArgs(
    args,
    "InvalidGrammarDependentsLookup",
    "_fuzz-grammar-dependents-of",
  );
  if ("tag" in parsed) return parsed;
  const { productions, target } = parsed;
  let byTarget = productionDependentsCache.get(productions);
  if (byTarget === undefined) {
    const collected = new Map<string, bigint[]>();
    for (let index = 0; index < productions.items.length; index += 1) {
      const production = productions.items[index]!;
      if (
        production.kind !== "expr" ||
        production.items.length !== 5 ||
        production.items[4]!.kind !== "expr" ||
        production.items[4]!.items.length !== 2
      )
        return operationError(
          "InvalidGrammarDependentsLookup",
          "_fuzz-grammar-dependents-of",
          "MalformedProduction",
        );
      for (const target of templateReferenceTargetAtoms(production.items[4]!.items[1]!)) {
        const key = structuralAtomKey(target, "Exact");
        if (!key.ok) return ok(key.reason);
        const bucket = collected.get(key.key);
        if (bucket === undefined) collected.set(key.key, [BigInt(index)]);
        else if (bucket[bucket.length - 1] !== BigInt(index)) bucket.push(BigInt(index));
      }
    }
    byTarget = new Map();
    for (const [key, indices] of collected)
      byTarget.set(key, expr(indices.map((value) => gint(value))));
    productionDependentsCache.set(productions, byTarget);
  }
  const targetKey = structuralAtomKey(target, "Exact");
  if (!targetKey.ok) return ok(targetKey.reason);
  return ok(expr([sym("GrammarDependents"), byTarget.get(targetKey.key) ?? expr([])]));
};

// Seeds the worklist: a nested stack of production indices 0..count-1, popping in ascending order.
const fuzzIndexStack: GroundFn = (args) => {
  if (args.length !== 1) return arityError("_fuzz-index-stack", 1, args.length);
  const count = integralNumberValue(args[0]!);
  if (count === undefined || count < 0n)
    return operationError("InvalidIndexStack", "_fuzz-index-stack", "ExpectedNonNegativeCount");
  let stack: Atom = sym("FuzzStackBottom");
  for (let index = Number(count) - 1; index >= 0; index -= 1)
    stack = expr([FUZZ_STACK_HEAD, gint(BigInt(index)), stack]);
  return ok(stack);
};

// ---- template instruction plans ----
// Compiles a prepared template (fields resolved, refs indexed) into the flat postorder
// instruction list the grammar machine executes. Mirrors the recursive interpreter's
// template dispatch exactly: the reserved forms at their exact arities become dedicated
// instructions, every other expression generates all of its items (a non-reserved head
// included) as children, and every other atom is a literal leaf. Memoized by template
// identity: StaticGrammar templates are stable, so each compiles once per process.
const templatePlanCache = new WeakMap<Atom, Atom>();

function compileTemplatePlan(template: Atom): Atom[] | Atom {
  type Task =
    | { readonly tag: "visit"; readonly atom: Atom; readonly out: Atom[] }
    | { readonly tag: "emit-expr"; readonly out: Atom[] }
    | {
        readonly tag: "emit-bind";
        readonly sort: Atom;
        readonly body: Atom[];
        readonly out: Atom[];
      }
    | {
        readonly tag: "emit-scoped";
        readonly normalized: Atom;
        readonly minimumNextId: bigint;
        readonly raw: Atom;
        readonly body: Atom[];
        readonly out: Atom[];
      };
  const rootOut: Atom[] = [];
  const pending: Task[] = [{ tag: "visit", atom: template, out: rootOut }];
  while (pending.length > 0) {
    const task = pending.pop()!;
    if (task.tag === "emit-expr") {
      task.out.push(expr([GI_EXPR_BUILD_HEAD]));
      continue;
    }
    if (task.tag === "emit-bind") {
      task.out.push(expr([GI_BIND_HEAD, expr([QUOTE_HEAD, task.sort]), expr(task.body)]));
      continue;
    }
    if (task.tag === "emit-scoped") {
      task.out.push(
        expr([
          GI_SCOPED_HEAD,
          task.normalized,
          gint(task.minimumNextId),
          expr([QUOTE_HEAD, task.raw]),
          expr(task.body),
        ]),
      );
      continue;
    }
    const { atom, out } = task;
    if (atom.kind === "expr" && atom.items.length > 0 && atom.items[0]!.kind === "sym") {
      const head = atom.items[0]!.name;
      if (head === "Literal" && atom.items.length === 2) {
        out.push(expr([GI_LIT_HEAD, expr([QUOTE_HEAD, atom.items[1]!])]));
        continue;
      }
      if (head === "Field" && atom.items.length === 2) {
        out.push(expr([GI_FIELD_HEAD, atom.items[1]!]));
        continue;
      }
      if (head === "Ref" && atom.items.length === 2) {
        out.push(expr([GI_REF_HEAD, expr([QUOTE_HEAD, atom.items[1]!]), gint(0), gint(1)]));
        continue;
      }
      if (head === GRAMMAR_INDEXED_REFERENCE_HEAD.name && atom.items.length === 4) {
        const ordinal = integralNumberValue(atom.items[2]!);
        const total = integralNumberValue(atom.items[3]!);
        if (ordinal === undefined || total === undefined)
          return kernelError(
            "InvalidGrammarTemplatePlan",
            expr([sym("Operation"), sym("_fuzz-grammar-template-plan")]),
            sym("MalformedIndexedReference"),
          );
        out.push(
          expr([GI_REF_HEAD, expr([QUOTE_HEAD, atom.items[1]!]), gint(ordinal), gint(total)]),
        );
        continue;
      }
      if (head === "Fresh" && atom.items.length === 2) {
        out.push(expr([GI_FRESH_HEAD, expr([QUOTE_HEAD, atom.items[1]!])]));
        continue;
      }
      if (head === "Use" && atom.items.length === 2) {
        out.push(expr([GI_USE_HEAD, expr([QUOTE_HEAD, atom.items[1]!])]));
        continue;
      }
      if (head === "Bind" && atom.items.length === 3) {
        const body: Atom[] = [];
        pending.push({ tag: "emit-bind", sort: atom.items[1]!, body, out });
        pending.push({ tag: "visit", atom: atom.items[2]!, out: body });
        continue;
      }
      if (head === "Scoped" && atom.items.length === 3) {
        const bindings = atom.items[1]!;
        if (bindings.kind !== "expr")
          return kernelError(
            "InvalidGrammarTemplatePlan",
            expr([sym("Operation"), sym("_fuzz-grammar-template-plan")]),
            sym("MalformedScopedBindings"),
          );
        const normalized: Atom[] = [];
        const seen = new Set<string>();
        let minimumNextId = 0n;
        for (const binding of bindings.items) {
          if (
            binding.kind !== "expr" ||
            binding.items.length !== 3 ||
            binding.items[0]!.kind !== "sym" ||
            binding.items[0]!.name !== "Binding"
          )
            return kernelError(
              "InvalidGrammarTemplatePlan",
              expr([sym("Operation"), sym("_fuzz-grammar-template-plan")]),
              sym("MalformedScopedBindings"),
            );
          const id = integralNumberValue(binding.items[2]!);
          if (id === undefined || id < 0n || seen.has(id.toString()))
            return kernelError(
              "InvalidGrammarTemplatePlan",
              expr([sym("Operation"), sym("_fuzz-grammar-template-plan")]),
              sym("MalformedScopedBindings"),
            );
          seen.add(id.toString());
          normalized.push(
            expr([sym("GrammarBinding"), expr([QUOTE_HEAD, binding.items[1]!]), binding.items[2]!]),
          );
          if (id + 1n > minimumNextId) minimumNextId = id + 1n;
        }
        const body: Atom[] = [];
        pending.push({
          tag: "emit-scoped",
          normalized: expr(normalized),
          minimumNextId,
          raw: bindings,
          body,
          out,
        });
        pending.push({ tag: "visit", atom: atom.items[2]!, out: body });
        continue;
      }
    }
    if (atom.kind === "expr") {
      out.push(expr([GI_EXPR_ENTER_HEAD, gint(atom.items.length)]));
      pending.push({ tag: "emit-expr", out });
      for (let index = atom.items.length - 1; index >= 0; index -= 1)
        pending.push({ tag: "visit", atom: atom.items[index]!, out });
      continue;
    }
    out.push(expr([GI_LIT_HEAD, expr([QUOTE_HEAD, atom])]));
  }
  return rootOut;
}

const grammarTemplatePlan: GroundFn = (args) => {
  if (args.length !== 1) return arityError("_fuzz-grammar-template-plan", 1, args.length);
  const template = args[0]!;
  const cached = templatePlanCache.get(template);
  if (cached !== undefined) return ok(cached);
  const instructions = compileTemplatePlan(template);
  if (isErrorAtom(instructions)) return ok(instructions);
  const plan = expr([GRAMMAR_TEMPLATE_PLAN_HEAD, expr(instructions)]);
  templatePlanCache.set(template, plan);
  return ok(plan);
};

// ---- machine stacks and memo ----

// Pushes `items` so they pop in forward order: the fit walker expands an expression's
// children onto its task stack without the O(n) flat-list concat per pop.
const fuzzStackPushAll: GroundFn = (args) => {
  if (args.length !== 2) return arityError("_fuzz-stack-push-all", 2, args.length);
  const items = args[1]!;
  if (items.kind !== "expr")
    return operationError("InvalidStackPush", "_fuzz-stack-push-all", "ExpectedExpression");
  let stack = args[0]!;
  for (let index = items.items.length - 1; index >= 0; index -= 1)
    stack = expr([FUZZ_STACK_HEAD, items.items[index]!, stack]);
  return ok(stack);
};

const fuzzStackTake: GroundFn = (args) => {
  if (args.length !== 2) return arityError("_fuzz-stack-take", 2, args.length);
  const count = integralNumberValue(args[1]!);
  if (count === undefined || count < 0n)
    return operationError("InvalidStackTake", "_fuzz-stack-take", "ExpectedNonNegativeCount");
  let rest = args[0]!;
  const popped: Atom[] = [];
  for (let taken = 0n; taken < count; taken += 1n) {
    if (
      rest.kind !== "expr" ||
      rest.items.length !== 3 ||
      rest.items[0]!.kind !== "sym" ||
      rest.items[0]!.name !== FUZZ_STACK_HEAD.name
    )
      return operationError("InvalidStackTake", "_fuzz-stack-take", "StackUnderflow");
    popped.push(rest.items[1]!);
    rest = rest.items[2]!;
  }
  popped.reverse();
  return ok(expr([FUZZ_STACK_TAKE_HEAD, expr(popped), rest]));
};

const grammarValidationPlan: GroundFn = (args) => {
  if (args.length !== 1) return arityError("_fuzz-grammar-validation-plan", 1, args.length);
  type Task = { readonly tag: "visit"; readonly atom: Atom } | { readonly tag: "scoped-exit" };

  const pending: Task[] = [{ tag: "visit", atom: args[0]! }];
  const events: Atom[] = [];
  while (pending.length > 0) {
    const task = pending.pop()!;
    if (task.tag === "scoped-exit") {
      events.push(expr([GRAMMAR_VALIDATION_SCOPED_EXIT_HEAD]));
      continue;
    }

    const atom = task.atom;
    if (atom.kind === "expr" && atom.items[0]?.kind === "sym") {
      const head = atom.items[0].name;
      if (
        ((head === "Literal" || head === "Ref" || head === "Fresh" || head === "Use") &&
          atom.items.length === 2) ||
        (head === "_FuzzGrammarRef" && atom.items.length === 4)
      ) {
        continue;
      }
      if (head === "Field" && atom.items.length === 2) {
        events.push(expr([GRAMMAR_VALIDATION_FIELD_HEAD, expr([QUOTE_HEAD, atom.items[1]!])]));
        continue;
      }
      if (head === "Bind" && atom.items.length === 3) {
        pending.push({ tag: "visit", atom: atom.items[2]! });
        continue;
      }
      if (head === "Scoped" && atom.items.length === 3) {
        events.push(
          expr([GRAMMAR_VALIDATION_SCOPED_ENTER_HEAD, expr([QUOTE_HEAD, atom.items[1]!])]),
        );
        pending.push({ tag: "scoped-exit" });
        pending.push({ tag: "visit", atom: atom.items[2]! });
        continue;
      }
      if (GRAMMAR_RESERVED_TEMPLATE_HEADS.has(head)) {
        events.push(expr([GRAMMAR_VALIDATION_MALFORMED_HEAD, expr([QUOTE_HEAD, atom])]));
        continue;
      }
    }

    if (atom.kind !== "expr") continue;
    for (let index = atom.items.length - 1; index >= 0; index -= 1)
      pending.push({ tag: "visit", atom: atom.items[index]! });
  }

  return ok(expr([GRAMMAR_VALIDATION_PLAN_HEAD, expr(events)]));
};

const grammarReferenceTargets: GroundFn = (args) => {
  if (args.length !== 1) return arityError("_fuzz-grammar-template-reference-plan", 1, args.length);
  const pending: Atom[] = [args[0]!];
  const targets: Atom[] = [];
  while (pending.length > 0) {
    const atom = pending.pop()!;
    if (
      atom.kind === "expr" &&
      atom.items[0]?.kind === "sym" &&
      ((atom.items[0].name === "Ref" && atom.items.length === 2) ||
        (atom.items[0].name === "_FuzzGrammarRef" && atom.items.length === 4))
    ) {
      targets.push(expr([QUOTE_HEAD, atom.items[1]!]));
      continue;
    }
    const indices = grammarTemplateChildIndices(atom);
    for (let index = indices.length - 1; index >= 0; index -= 1)
      pending.push((atom as Extract<Atom, { readonly kind: "expr" }>).items[indices[index]!]!);
  }
  return ok(expr([GRAMMAR_REFERENCE_TARGETS_HEAD, expr(targets)]));
};

const atomGround: GroundFn = (args) => {
  if (args.length !== 1) return arityError("_fuzz-atom-ground", 1, args.length);
  return ok(gbool(args[0]!.ground));
};

const customReplayTree: GroundFn = (args) => {
  if (args.length !== 2) return arityError("_fuzz-custom-replay-tree", 2, args.length);
  const [result, expectedMode] = args;
  if (
    result!.kind === "expr" &&
    result!.items.length === 3 &&
    atomEq(result!.items[0]!, FUZZ_GENERATION_ERROR_HEAD)
  ) {
    return ok(expr([CUSTOM_REPLAY_SKIP_HEAD]));
  }
  if (
    result!.kind !== "expr" ||
    result!.items.length !== 4 ||
    (!atomEq(result!.items[0]!, FUZZ_SAMPLE_HEAD) &&
      !atomEq(result!.items[0]!, FUZZ_GENERATION_DISCARD_HEAD))
  ) {
    return ok(
      expr([
        CUSTOM_REPLAY_PROTOCOL_ERROR_HEAD,
        sym("MalformedGenerationResult"),
        expr([sym("Details"), expr([sym("Value"), result!])]),
      ]),
    );
  }

  const driver = result!.items[2]!;
  if (
    driver.kind !== "expr" ||
    driver.items.length !== 3 ||
    !atomEq(driver.items[0]!, FUZZ_DRIVER_HEAD) ||
    !atomEq(driver.items[1]!, expectedMode!)
  ) {
    return ok(
      expr([
        CUSTOM_REPLAY_PROTOCOL_ERROR_HEAD,
        sym("CustomDriverMismatch"),
        expr([
          sym("Details"),
          expr([sym("ExpectedMode"), expectedMode!]),
          expr([sym("ActualDriver"), driver]),
        ]),
      ]),
    );
  }
  // A tree the replay key rejects (an external grounded value, an executable grounded, a
  // custom matcher) cannot round-trip through replay at all, so self-replay validation is
  // skipped and the runner's nonreplayable handling keeps the original failure evidence.
  const treeKey = structuralAtomKey(result!.items[3]!, "Replay");
  if (!treeKey.ok) return ok(expr([CUSTOM_REPLAY_SKIP_HEAD]));
  return ok(expr([CUSTOM_REPLAY_TREE_HEAD, result!.items[3]!]));
};

const customReplayEqual: GroundFn = (args) => {
  if (args.length !== 2) return arityError("_fuzz-custom-replay-equal", 2, args.length);
  const [original, replayed] = args;
  if (
    original!.kind !== "expr" ||
    replayed!.kind !== "expr" ||
    original!.items.length !== 4 ||
    replayed!.items.length !== 4 ||
    !atomEq(original!.items[0]!, replayed!.items[0]!) ||
    (!atomEq(original!.items[0]!, FUZZ_SAMPLE_HEAD) &&
      !atomEq(original!.items[0]!, FUZZ_GENERATION_DISCARD_HEAD))
  ) {
    return ok(gbool(false));
  }
  return ok(
    gbool(
      replayAtomEqual(original!.items[1]!, replayed!.items[1]!, true) &&
        atomsEqualForKeyMode(original!.items[3]!, replayed!.items[3]!, "Replay"),
    ),
  );
};

const bitsOfFloat64: GroundFn = (args) => {
  if (args.length !== 1) return arityError("_fuzz-float64-bits", 1, args.length);
  const value = floatValue(args[0]!);
  if (value === undefined)
    return operationError("InvalidFloat", "_fuzz-float64-bits", "ExpectedFloat");
  const [high, low] = float64Words(value);
  return ok(expr([FLOAT_BITS_HEAD, gint(high), gint(low)]));
};

const float64OfBits: GroundFn = (args) => {
  if (args.length !== 2) return arityError("_fuzz-float64-from-bits", 2, args.length);
  const high = unsigned32Value(args[0]!);
  const low = unsigned32Value(args[1]!);
  if (high === undefined || low === undefined)
    return operationError("InvalidFloatBits", "_fuzz-float64-from-bits", "ExpectedUnsigned32Words");
  return ok(gfloat(float64FromWords(high, low)));
};

const indexOfFloat64: GroundFn = (args) => {
  if (args.length !== 1) return arityError("_fuzz-float64-index", 1, args.length);
  const value = floatValue(args[0]!);
  if (value === undefined)
    return operationError("InvalidFloat", "_fuzz-float64-index", "ExpectedFloat");
  const index = float64Index(value);
  if (index === undefined)
    return operationError("InvalidFloat", "_fuzz-float64-index", "NaNHasNoOrderedIndex");
  return ok(expr([FLOAT_INDEX_HEAD, gint(index)]));
};

const float64OfIndex: GroundFn = (args) => {
  if (args.length !== 1) return arityError("_fuzz-float64-from-index", 1, args.length);
  const index = integralNumberValue(args[0]!);
  if (index === undefined)
    return operationError("InvalidFloatIndex", "_fuzz-float64-from-index", "ExpectedInteger");
  const value = float64FromIndex(index);
  if (value === undefined)
    return operationError("InvalidFloatIndex", "_fuzz-float64-from-index", "OutOfRange");
  return ok(gfloat(value));
};

function unicodeScalarAt(index: bigint): number | undefined {
  if (index < 0n || index >= UNICODE_SCALAR_COUNT) return undefined;
  if (index < UNICODE_FIRST_GAP_INDEX) return Number(index);
  if (index < UNICODE_SECOND_GAP_INDEX) return Number(index + 2_048n);
  return Number(index + 2_050n);
}

const unicodeCharacterAt: GroundFn = (args) => {
  if (args.length !== 1) return arityError("_fuzz-unicode-character", 1, args.length);
  const index = integralNumberValue(args[0]!);
  if (index === undefined)
    return operationError("InvalidCharacterIndex", "_fuzz-unicode-character", "ExpectedInteger");
  const scalar = unicodeScalarAt(index);
  if (scalar === undefined)
    return operationError("InvalidCharacterIndex", "_fuzz-unicode-character", "OutOfRange");
  return ok(sym(String.fromCodePoint(scalar)));
};

function replayGroundEqual(
  left: Extract<Atom, { readonly kind: "gnd" }>,
  right: Extract<Atom, { readonly kind: "gnd" }>,
): boolean {
  if (
    left.exec !== undefined ||
    right.exec !== undefined ||
    left.match !== undefined ||
    right.match !== undefined ||
    !atomEq(left.typ, groundType(left.value)) ||
    !atomEq(right.typ, groundType(right.value)) ||
    left.value.g !== right.value.g
  ) {
    return false;
  }

  switch (left.value.g) {
    case "int":
      return BigInt(left.value.n) === BigInt((right.value as typeof left.value).n);
    case "float":
      return float64Bits(left.value.n) === float64Bits((right.value as typeof left.value).n);
    case "str":
      return left.value.s === (right.value as typeof left.value).s;
    case "bool":
      return left.value.b === (right.value as typeof left.value).b;
    case "unit":
      return true;
    case "error":
      return left.value.msg === (right.value as typeof left.value).msg;
    case "ext":
      return false;
  }
}

function replayAtomEqual(left: Atom, right: Atom, alphaVariables = false): boolean {
  const pending: Array<readonly [Atom, Atom]> = [[left, right]];
  const leftVariables = new Map<string, string>();
  const rightVariables = new Map<string, string>();
  while (pending.length > 0) {
    const [currentLeft, currentRight] = pending.pop()!;
    if (currentLeft.kind !== currentRight.kind) return false;
    switch (currentLeft.kind) {
      case "sym":
        if (currentLeft.name !== currentRight.name) return false;
        break;
      case "var": {
        if (currentRight.kind !== "var") return false;
        if (!alphaVariables) {
          if (currentLeft.name !== currentRight.name) return false;
          break;
        }
        const mappedRight = leftVariables.get(currentLeft.name);
        const mappedLeft = rightVariables.get(currentRight.name);
        if (mappedRight === undefined && mappedLeft === undefined) {
          leftVariables.set(currentLeft.name, currentRight.name);
          rightVariables.set(currentRight.name, currentLeft.name);
        } else if (mappedRight !== currentRight.name || mappedLeft !== currentLeft.name) {
          return false;
        }
        break;
      }
      case "gnd":
        if (currentRight.kind !== "gnd" || !replayGroundEqual(currentLeft, currentRight))
          return false;
        break;
      case "expr":
        if (currentRight.kind !== "expr") return false;
        if (currentLeft.items.length !== currentRight.items.length) return false;
        for (let index = 0; index < currentLeft.items.length; index += 1) {
          pending.push([currentLeft.items[index]!, currentRight.items[index]!]);
        }
        break;
    }
  }
  return true;
}

const replayEqual: GroundFn = (args) => {
  if (args.length !== 2) return arityError("_fuzz-replay-equal", 2, args.length);
  return ok(gbool(replayAtomEqual(args[0]!, args[1]!)));
};

function encodeGrounded(atom: Extract<Atom, { readonly kind: "gnd" }>): Atom {
  if (atom.value.g === "ext")
    return kernelError("NonReplayableGroundedValue", sym("ExternalGrounded"));
  if (atom.exec !== undefined)
    return kernelError("NonReplayableGroundedValue", sym("ExecutableGrounded"));
  if (atom.match !== undefined)
    return kernelError("NonReplayableGroundedValue", sym("CustomMatcher"));
  if (!atomEq(atom.typ, groundType(atom.value)))
    return kernelError("NonReplayableGroundedValue", sym("CustomGroundedType"));

  switch (atom.value.g) {
    case "int":
      return expr([ENCODED_INTEGER, gint(atom.value.n)]);
    case "float":
      return expr([ENCODED_FLOAT, ...float64Words(atom.value.n).map(gint)]);
    case "str":
      return expr([ENCODED_STRING, gstr(atom.value.s)]);
    case "bool":
      return expr([ENCODED_BOOLEAN, gbool(atom.value.b)]);
    case "unit":
      return expr([ENCODED_UNIT]);
    case "error":
      return expr([ENCODED_ERROR, gstr(atom.value.msg)]);
  }
}

function isKernelErrorAtom(atom: Atom): boolean {
  return atom.kind === "expr" && atom.items.length > 0 && atomEq(atom.items[0]!, ERROR_HEAD);
}

function encodeReplayAtom(atom: Atom): Atom {
  type Task =
    | { readonly tag: "atom"; readonly atom: Atom }
    | { readonly tag: "expression"; readonly count: number };
  const pending: Task[] = [{ tag: "atom", atom }];
  const encoded: Atom[] = [];

  while (pending.length > 0) {
    const task = pending.pop()!;
    if (task.tag === "expression") {
      const children = encoded.splice(encoded.length - task.count, task.count);
      const error = children.find(isKernelErrorAtom);
      if (error !== undefined) return error;
      encoded.push(expr([ENCODED_EXPRESSION, expr(children)]));
      continue;
    }

    const current = task.atom;
    switch (current.kind) {
      case "sym":
        encoded.push(expr([ENCODED_SYMBOL, gstr(current.name)]));
        break;
      case "var":
        encoded.push(expr([ENCODED_VARIABLE, gstr(current.name)]));
        break;
      case "gnd":
        encoded.push(encodeGrounded(current));
        break;
      case "expr":
        pending.push({ tag: "expression", count: current.items.length });
        for (let index = current.items.length - 1; index >= 0; index -= 1) {
          pending.push({ tag: "atom", atom: current.items[index]! });
        }
        break;
    }
  }

  const payload = encoded[0]!;
  return isKernelErrorAtom(payload)
    ? payload
    : expr([ENCODED_ATOM_HEAD, gint(FUZZ_ATOM_CODEC_VERSION), payload]);
}

function codecError(detail: string): DecodePayload {
  return {
    tag: "error",
    error: kernelError(
      "InvalidEncodedAtom",
      expr([sym("Operation"), sym("_fuzz-decode-atom")]),
      sym(detail),
    ),
  };
}

function payloadString(payload: Atom, head: Atom): string | undefined {
  if (payload.kind !== "expr" || payload.items.length !== 2 || !atomEq(payload.items[0]!, head)) {
    return undefined;
  }
  const value = payload.items[1]!;
  return value.kind === "gnd" && value.value.g === "str" ? value.value.s : undefined;
}

function decodePayload(payload: Atom): DecodePayload {
  if (payload.kind !== "expr" || payload.items.length === 0) return codecError("MalformedPayload");
  const head = payload.items[0]!;

  if (atomEq(head, ENCODED_SYMBOL)) {
    const name = payloadString(payload, ENCODED_SYMBOL);
    return name === undefined ? codecError("MalformedSymbol") : { tag: "atom", atom: sym(name) };
  }
  if (atomEq(head, ENCODED_VARIABLE)) {
    const name = payloadString(payload, ENCODED_VARIABLE);
    return name === undefined
      ? codecError("MalformedVariable")
      : { tag: "atom", atom: variable(name) };
  }
  if (atomEq(head, ENCODED_EXPRESSION)) {
    if (payload.items.length !== 2 || payload.items[1]!.kind !== "expr")
      return codecError("MalformedExpression");
    return { tag: "expression", children: payload.items[1]!.items };
  }
  if (atomEq(head, ENCODED_INTEGER)) {
    if (payload.items.length !== 2 || exactIntegerValue(payload.items[1]!) === undefined)
      return codecError("MalformedInteger");
    return { tag: "atom", atom: gint(exactIntegerValue(payload.items[1]!)!) };
  }
  if (atomEq(head, ENCODED_FLOAT)) {
    if (payload.items.length !== 3) return codecError("MalformedFloat64Bits");
    const high = unsigned32Value(payload.items[1]!);
    const low = unsigned32Value(payload.items[2]!);
    if (high === undefined || low === undefined) return codecError("MalformedFloat64Bits");
    return { tag: "atom", atom: gfloat(float64FromWords(high, low)) };
  }
  if (atomEq(head, ENCODED_STRING)) {
    const value = payloadString(payload, ENCODED_STRING);
    return value === undefined ? codecError("MalformedString") : { tag: "atom", atom: gstr(value) };
  }
  if (atomEq(head, ENCODED_BOOLEAN)) {
    if (
      payload.items.length !== 2 ||
      payload.items[1]!.kind !== "gnd" ||
      payload.items[1]!.value.g !== "bool"
    ) {
      return codecError("MalformedBoolean");
    }
    return { tag: "atom", atom: gbool(payload.items[1]!.value.b) };
  }
  if (atomEq(head, ENCODED_UNIT)) {
    return payload.items.length === 1 ? { tag: "atom", atom: gunit } : codecError("MalformedUnit");
  }
  if (atomEq(head, ENCODED_ERROR)) {
    const message = payloadString(payload, ENCODED_ERROR);
    return message === undefined
      ? codecError("MalformedError")
      : { tag: "atom", atom: gnd({ g: "error", msg: message }) };
  }
  return codecError("UnknownPayloadTag");
}

function decodeReplayAtom(encoded: Atom): Atom {
  if (
    encoded.kind !== "expr" ||
    encoded.items.length !== 3 ||
    !atomEq(encoded.items[0]!, ENCODED_ATOM_HEAD) ||
    exactIntegerValue(encoded.items[1]!) !== BigInt(FUZZ_ATOM_CODEC_VERSION)
  ) {
    return kernelError(
      "InvalidEncodedAtom",
      expr([sym("Operation"), sym("_fuzz-decode-atom")]),
      sym("ExpectedVersion1"),
    );
  }

  type Task =
    | { readonly tag: "payload"; readonly payload: Atom }
    | { readonly tag: "expression"; readonly count: number };
  const pending: Task[] = [{ tag: "payload", payload: encoded.items[2]! }];
  const decoded: Atom[] = [];

  while (pending.length > 0) {
    const task = pending.pop()!;
    if (task.tag === "expression") {
      decoded.push(expr(decoded.splice(decoded.length - task.count, task.count)));
      continue;
    }

    const payload = decodePayload(task.payload);
    if (payload.tag === "error") return payload.error;
    if (payload.tag === "atom") {
      decoded.push(payload.atom);
      continue;
    }
    pending.push({ tag: "expression", count: payload.children.length });
    for (let index = payload.children.length - 1; index >= 0; index -= 1) {
      pending.push({ tag: "payload", payload: payload.children[index]! });
    }
  }

  return decoded[0]!;
}

const encodeAtom: GroundFn = (args) => {
  if (args.length !== 1) return arityError("_fuzz-encode-atom", 1, args.length);
  return ok(encodeReplayAtom(args[0]!));
};

const decodeAtom: GroundFn = (args) => {
  if (args.length !== 1) return arityError("_fuzz-decode-atom", 1, args.length);
  return ok(decodeReplayAtom(args[0]!));
};

// The same codec the `_fuzz-encode-atom` and `_fuzz-decode-atom` operations expose to MeTTa, for a
// host that has to write an atom somewhere text-only and read it back. Both return an `Error` atom
// rather than throwing: an atom carrying a grounded value with no encoding has no representation, and
// a stored payload can be corrupted.
export { encodeReplayAtom as encodeAtomForStorage, decodeReplayAtom as decodeAtomFromStorage };

const KERNEL_OPERATIONS = [
  ["_fuzz-rng-init", rngInit],
  ["_fuzz-draw-int", drawInt],
  ["_fuzz-atom-key", atomKey],
  ["_fuzz-deduplicate-exact", deduplicateExact],
  ["_fuzz-deduplicate-replay", deduplicateReplay],
  ["_fuzz-exact-member", exactMember],
  ["_fuzz-replay-member", replayMember],
  ["_fuzz-make-variable", makeVariable],
  ["_fuzz-variable-marker", variableMarker],
  ["_fuzz-contains-variable-marker", containsVariableMarker],
  ["_fuzz-materialize-grammar-sample", materializeGrammarSample],
  ["_fuzz-expression-append", appendExpressionItem],
  ["_fuzz-expression-concat", concatenateExpressions],
  ["_fuzz-grammar-summary-alternatives", grammarSummaryAlternatives],
  ["_fuzz-grammar-summary-replace", grammarSummaryReplace],
  ["_fuzz-grammar-alternatives-add", grammarAlternativesAdd],
  ["_fuzz-grammar-template-requirements-op", grammarTemplateRequirements],
  ["_fuzz-grammar-productivity-op", grammarProductivityOp],
  ["_fuzz-grammar-targets-op", grammarTargetsOp],
  ["_fuzz-grammar-validate-references-op", grammarValidateReferencesOp],
  ["_fuzz-stack-to-expression", fuzzStackToExpression],
  ["_fuzz-grammar-eligible-productions-op", grammarEligibleProductions],
  ["_fuzz-grammar-machine-op", grammarMachineOp],
  ["_fuzz-decision-leaves-op", decisionLeaves],
  ["_fuzz-grammar-productions-for-target", grammarProductionsForTarget],
  ["_fuzz-grammar-dependents-of", grammarDependentsOf],
  ["_fuzz-index-stack", fuzzIndexStack],
  ["_fuzz-grammar-template-plan", grammarTemplatePlan],
  ["_fuzz-stack-take", fuzzStackTake],
  ["_fuzz-stack-push-all", fuzzStackPushAll],
  ["_fuzz-expression-view", expressionView],
  ["_fuzz-grammar-field-expressions", grammarFieldExpressions],
  ["_fuzz-grammar-replace-fields", replaceGrammarFields],
  ["_fuzz-grammar-index-references", indexGrammarReferences],
  ["_fuzz-grammar-template-profile", grammarTemplateProfile],
  ["_fuzz-grammar-validation-plan", grammarValidationPlan],
  ["_fuzz-grammar-template-reference-plan", grammarReferenceTargets],
  ["_fuzz-atom-ground", atomGround],
  ["_fuzz-custom-replay-tree", customReplayTree],
  ["_fuzz-custom-replay-equal", customReplayEqual],
  ["_fuzz-float64-bits", bitsOfFloat64],
  ["_fuzz-float64-from-bits", float64OfBits],
  ["_fuzz-float64-index", indexOfFloat64],
  ["_fuzz-float64-from-index", float64OfIndex],
  ["_fuzz-unicode-character", unicodeCharacterAt],
  ["_fuzz-replay-equal", replayEqual],
  ["_fuzz-encode-atom", encodeAtom],
  ["_fuzz-decode-atom", decodeAtom],
] as const;

let registered = false;

/** Install the deterministic state-in/state-out primitives used by the MeTTa fuzz module. */
export function registerFuzzKernel(): void {
  if (registered) return;
  for (const [name, operation] of KERNEL_OPERATIONS) {
    registerBuiltinGroundedOperation(name, operation, "Pure");
  }
  registered = true;
}
