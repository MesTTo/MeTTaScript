// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

import {
  type Atom,
  type GroundFn,
  type ReduceResult,
  atomEq,
  expr,
  gint,
  groundType,
  gstr,
  registerBuiltinGroundedOperation,
  sym,
  variable,
} from "@mettascript/core";
import { uniformBigInt } from "pure-rand/distribution/uniformBigInt";
import { xorshift128plus, xorshift128plusFromState } from "pure-rand/generator/xorshift128plus";

export const FUZZ_RNG_ALGORITHM = "xorshift128plus-v1";
export const FUZZ_ATOM_KEY_ALGORITHM = "mettascript-atom-key-v1";

const RNG_HEAD = sym("FuzzRng");
const RNG_ALGORITHM = sym(FUZZ_RNG_ALGORITHM);
const DRAW_HEAD = sym("FuzzDraw");
const ERROR_HEAD = sym("FuzzKernelError");
const MIN_I32 = -0x80000000;
const MAX_I32 = 0x7fffffff;

type RngState = readonly [number, number, number, number];
type KeyMode = "Exact" | "Alpha";
type KeyResult =
  | { readonly ok: true; readonly key: string }
  | { readonly ok: false; readonly reason: Atom };

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

function groundedKey(atom: Extract<Atom, { readonly kind: "gnd" }>): KeyResult {
  if (atom.value.g === "ext") return nonReplayable("ExternalGrounded");
  if (atom.exec !== undefined) return nonReplayable("ExecutableGrounded");
  if (atom.match !== undefined) return nonReplayable("CustomMatcher");
  if (!atomEq(atom.typ, groundType(atom.value))) return nonReplayable("CustomGroundedType");

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
  const output = [`${FUZZ_ATOM_KEY_ALGORITHM};`];
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
        if (mode === "Alpha") {
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
        const encoded = groundedKey(current);
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
  if (mode.kind !== "sym" || (mode.name !== "Exact" && mode.name !== "Alpha"))
    return operationError("InvalidKeyMode", "_fuzz-atom-key", "ExpectedExactOrAlpha");
  const result = structuralAtomKey(args[1]!, mode.name);
  return ok(result.ok ? gstr(result.key) : result.reason);
};

const deduplicateExact: GroundFn = (args) => {
  if (args.length !== 1) return arityError("_fuzz-deduplicate-exact", 1, args.length);
  const values = args[0]!;
  if (values.kind !== "expr")
    return operationError(
      "InvalidDeduplicationInput",
      "_fuzz-deduplicate-exact",
      "ExpectedExpression",
    );

  const buckets = new Map<string, Atom[]>();
  const unique: Atom[] = [];
  for (const value of values.items) {
    const encoded = structuralAtomKey(value, "Exact");
    if (!encoded.ok) return ok(encoded.reason);
    const bucket = buckets.get(encoded.key);
    if (bucket?.some((seen) => atomEq(seen, value)) === true) continue;
    if (bucket === undefined) buckets.set(encoded.key, [value]);
    else bucket.push(value);
    unique.push(value);
  }
  return ok(expr(unique));
};

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

const KERNEL_OPERATIONS = [
  ["_fuzz-rng-init", rngInit],
  ["_fuzz-draw-int", drawInt],
  ["_fuzz-atom-key", atomKey],
  ["_fuzz-deduplicate-exact", deduplicateExact],
  ["_fuzz-make-variable", makeVariable],
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
