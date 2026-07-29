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

function integerValue(atom: Atom): bigint | undefined {
  return atom.kind === "gnd" && atom.value.g === "int" ? BigInt(atom.value.n) : undefined;
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
  const value = integerValue(atom);
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
    const value = integerValue(part);
    if (value === undefined || value < BigInt(MIN_I32) || value > BigInt(MAX_I32)) return undefined;
    state.push(Number(value));
  }
  if (state.every((value) => value === 0)) return undefined;
  return [state[0]!, state[1]!, state[2]!, state[3]!];
}

const rngInit: GroundFn = (args) => {
  if (args.length !== 1) return arityError("_fuzz-rng-init", 1, args.length);
  const seed = integerValue(args[0]!);
  if (seed === undefined) return operationError("InvalidSeed", "_fuzz-rng-init", "ExpectedInteger");
  const seed32 = Number(BigInt.asIntN(32, seed));
  return ok(rngStateAtom(xorshift128plus(seed32).getState()));
};

const drawInt: GroundFn = (args) => {
  if (args.length !== 3) return arityError("_fuzz-draw-int", 3, args.length);
  const state = parseRngState(args[0]!);
  if (state === undefined)
    return operationError("InvalidRngState", "_fuzz-draw-int", "ExpectedFuzzRng");
  const lower = integerValue(args[1]!);
  const upper = integerValue(args[2]!);
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
    return operationError(
      "InvalidKeyMode",
      "_fuzz-atom-key",
      "ExpectedExactAlphaReplayOrAlphaReplay",
    );
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
    if (
      valueKey.key === needleKey.key &&
      atomsEqualForKeyMode(value, needle, mode)
    )
      return ok(gbool(true));
  }
  return ok(gbool(false));
}

const exactMember: GroundFn = (args) => memberAtom(args, "_fuzz-exact-member", "Exact");

const replayMember: GroundFn = (args) => memberAtom(args, "_fuzz-replay-member", "Replay");

const makeVariable: GroundFn = (args) => {
  if (args.length !== 1) return arityError("_fuzz-make-variable", 1, args.length);
  const index = integerValue(args[0]!);
  if (index === undefined || index < 0n)
    return operationError(
      "InvalidVariableIndex",
      "_fuzz-make-variable",
      "ExpectedNonNegativeInteger",
    );
  return ok(variable(`fuzz-${index}`));
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
  const index = integerValue(args[0]!);
  if (index === undefined)
    return operationError("InvalidFloatIndex", "_fuzz-float64-from-index", "ExpectedInteger");
  const value = float64FromIndex(index);
  if (value === undefined)
    return operationError("InvalidFloatIndex", "_fuzz-float64-from-index", "OutOfRange");
  return ok(gfloat(value));
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

function replayAtomEqual(left: Atom, right: Atom): boolean {
  const pending: Array<readonly [Atom, Atom]> = [[left, right]];
  while (pending.length > 0) {
    const [currentLeft, currentRight] = pending.pop()!;
    if (currentLeft.kind !== currentRight.kind) return false;
    switch (currentLeft.kind) {
      case "sym":
        if (currentLeft.name !== currentRight.name) return false;
        break;
      case "var":
        if (currentLeft.name !== currentRight.name) return false;
        break;
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
    if (payload.items.length !== 2 || integerValue(payload.items[1]!) === undefined)
      return codecError("MalformedInteger");
    return { tag: "atom", atom: gint(integerValue(payload.items[1]!)!) };
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
    integerValue(encoded.items[1]!) !== BigInt(FUZZ_ATOM_CODEC_VERSION)
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

const KERNEL_OPERATIONS = [
  ["_fuzz-rng-init", rngInit],
  ["_fuzz-draw-int", drawInt],
  ["_fuzz-atom-key", atomKey],
  ["_fuzz-deduplicate-exact", deduplicateExact],
  ["_fuzz-deduplicate-replay", deduplicateReplay],
  ["_fuzz-exact-member", exactMember],
  ["_fuzz-replay-member", replayMember],
  ["_fuzz-make-variable", makeVariable],
  ["_fuzz-float64-bits", bitsOfFloat64],
  ["_fuzz-float64-from-bits", float64OfBits],
  ["_fuzz-float64-index", indexOfFloat64],
  ["_fuzz-float64-from-index", float64OfIndex],
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
