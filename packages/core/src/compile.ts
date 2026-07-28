// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Compile the pure, deterministic, value-returning subset of MeTTa to native JS closures.
// Single-equation functions operate on exact IntVal or f64 values, tuples, and booleans. Proven-exclusive
// constructor clauses can also carry ground atoms through native recursion, build atom results with nested
// scalar calls already evaluated, and box primitive branches when clauses mix primitive and atom returns.
// Integer operations reuse the interpreter's addInt/intDiv machinery; a FloatVal wrapper preserves the
// distinction between 3 and 3.0. Anything outside the proven subset returns to the interpreter. The
// internal memo makes overlapping-subproblem recursion such as fib polynomial and native.
import {
  type Atom,
  type SymAtom,
  type ExprAtom,
  atomEq,
  expr,
  gint,
  gfloat,
  gbool,
  sym,
  variable,
  atomVars,
  emptyExpr,
  NUMBER_FAMILY_TYPE_NAMES,
} from "./atom";
import { type CellVar, mkCell, derefCell, occursCell, unifyCellOccurs } from "./trail";
import {
  type JitGroup,
  type JitSearchState,
  type Slim,
  compileJitGroup,
  jitRuntime,
} from "./nondet-jit";
import {
  type Bindings,
  emptyBindings,
  prependValRaw,
  hasLoop,
  hasLoopFromBase,
  lookupVal,
} from "./bindings";
import { addVarBinding, matchAtoms, matchAtomsScoped, merge } from "./match";
import { instantiate } from "./instantiate";
import { IMPURE_OPS } from "./tabling";
import {
  type IntVal,
  addInt,
  subInt,
  mulInt,
  intDiv,
  intMod,
  isZero,
  toF64,
  cmpIntVal,
} from "./number";
import { callGrounded } from "./builtins";
import { type MinEnv, type St } from "./eval";
import {
  DEFAULT_MAX_STACK_DEPTH,
  EVALUATION_TRAMPOLINE_DEPTH,
  type EvaluationDepthBoundary,
  EvaluationDepth,
  EvaluationDepthHandoff,
  EvaluationDepthOverflow,
} from "./eval-depth";

/** Thrown by a compiled node when it meets a case it cannot handle faithfully (division by zero);
 *  the caller catches it (along with a native stack `RangeError`) and re-runs the call in the
 *  interpreter, which is sound because the compiled subset is side-effect-free. */
export const BAIL = Symbol("bail");
// Generated nondeterministic JIT frames are substantially smaller than evaluator or imperative frames.
// The constrained-stack witness reaches the default language bound in compiled code, so that bound cuts
// first. A larger or explicitly unlimited bound hands the next call to the heap evaluator.
const NONDET_JIT_TRAMPOLINE_DEPTH = DEFAULT_MAX_STACK_DEPTH;

function throwEvaluationDepthBoundary(
  boundary: EvaluationDepthBoundary,
  atom: Atom,
  state?: unknown,
): never {
  if (boundary === "overflow") throw new EvaluationDepthOverflow(atom, state);
  throw new EvaluationDepthHandoff(atom, state);
}

// A fixed-arity tuple of ints, the one non-scalar value the compiled core handles (PeTTa's iterate/
// quad-step thread a `($t $i $sum)` state tuple). Wrapped in a class so it is distinct from the plain
// array that makeRun's loop reads as a tail-call frame.
class Tup {
  constructor(readonly v: readonly IntVal[]) {}
}
/** A boxed f64 inside the native frame. Integers remain bare `IntVal`; the wrapper keeps `3` distinct
 *  from `3.0` even though both use a JavaScript number. */
class FloatVal {
  constructor(readonly n: number) {}
}
type FrameVal = IntVal | FloatVal | Tup | Atom;
type Ty =
  | "int"
  | "float"
  | "number"
  | "bool"
  | "atom"
  | "sym"
  | `tuple${number}`
  | `symtuple${number}`;
type Node = (frame: FrameVal[], runtime: FunctionalRuntime) => FrameVal | boolean;
interface Compiled {
  readonly node: Node;
  readonly type: Ty;
}

/** A compiled pure function. `run` is filled after the whole dependency group is compiled, so mutual
 *  recursion resolves through the holder object. */
interface FunctionalHolder {
  kind: "functional";
  name: string;
  arity: number;
  retType: Ty;
  paramTypes: Ty[];
  run: (vals: FrameVal[], runtime?: FunctionalRuntime, entered?: boolean) => FrameVal | boolean;
}
/** A deterministic constructor dispatch with at least one native value- or atom-returning clause. Clauses
 *  outside the subset remain interpreter fallbacks, so exclusivity is proved over all clauses. */
interface ScalarHolder {
  kind: "scalar";
  name: string;
  arity: number;
  retType: "number" | "atom";
  paramTypes: Ty[];
  clauseCount: number;
  run: (vals: FrameVal[], runtime?: FunctionalRuntime, entered?: boolean) => FrameVal | boolean;
}
interface FunctionalRuntime {
  readonly depth: EvaluationDepth;
  readonly limit: number;
  readonly counterBase: number;
  readonly counterLimit: number | undefined;
  counterDelta: number;
  freshSuffix: string;
}
interface CompiledAtomResult {
  readonly atom: Atom;
  readonly bnd: Bindings;
}
export interface CompiledRunResult {
  readonly results: readonly CompiledAtomResult[];
  readonly counterDelta: number;
  readonly state?: St;
  /** The holder reduced each result fully and checked that the current world cannot change that result.
   *  The evaluator may skip the ordinary RHS reduction for this call. */
  readonly resultsFinal?: boolean;
}
interface RewriteHolder {
  kind: "rewrite";
  arity: number;
  retType: Ty;
  paramTypes: Ty[];
  ruleCount: number;
  run: (partAtoms: readonly Atom[]) => CompiledRunResult | undefined;
}
// A compiled general symbolic constructor function: every static clause is a left-linear constructor
// rewrite (nested symbol/constructor LHS patterns; an RHS of symbols, ground literals, LHS-bound vars,
// fresh RHS-only vars, and nested recursive calls). Generalises RewriteHolder (flat symbol tuples) to
// nested patterns, recursive RHS terms, and surviving fresh variables. `run` is a specialised queryOp:
// for a GROUND call it replaces the per-application matchAtomsScoped tree-walk + instantiate with a
// positional match + template build, preserving the interpreter's fresh-variable numbering (clause i
// freshens with suffix "#"+(counter+i); the counter advances by the clause count) and candidate order.
interface SymbolicHolder {
  kind: "symbolic";
  arity: number;
  clauseCount: number;
  run: (partAtoms: readonly Atom[], counter: number) => CompiledRunResult | undefined;
}
export interface CompiledImpureOps {
  /** Per-evaluation logical call lineage. The evaluator supplies it at the compiled boundary; recursive
   *  holders enter it before invoking another user equation. */
  readonly evaluationDepth?: EvaluationDepth;
  readonly maxStackDepth?: number;
  readonly addAtom: (env: MinEnv, st: St, space: Atom, atom: Atom) => St | undefined;
  /** Solutions of a `(match space pattern template)` under the current world: the instantiated
   *  template plus that solution's bindings, in the interpreter's own candidate order, and the
   *  fresh-variable counter advance the interpreted match would have cost. Undefined = not a space. */
  readonly matchSolutions?: (
    env: MinEnv,
    st: St,
    space: Atom,
    pattern: Atom,
    template: Atom,
  ) =>
    | { readonly pairs: ReadonlyArray<readonly [Atom, Bindings]>; readonly counterDelta: number }
    | undefined;
  /** The add-if-absent idiom on a ground atom: exact-membership probe, then append when absent.
   *  Undefined when the fast probe is unsound for this space (non-ground facts, static facts of the
   *  same head, state handles), sending the caller back to the interpreter. */
  readonly addIfAbsent?: (
    env: MinEnv,
    st: St,
    space: Atom,
    atom: Atom,
  ) => { readonly added: boolean; readonly state: St } | undefined;
}
type ImpEval = { readonly value: Atom; readonly st: St } | typeof BAIL;
type ImpEmit = (value: Atom, st: St) => St | typeof BAIL;
type ImpForEach = (
  slots: readonly Atom[],
  st: St,
  ops: CompiledImpureOps,
  discard: boolean | undefined,
  emit: ImpEmit,
) => St | typeof BAIL;
interface ImperativeHolder {
  kind: "imperative";
  arity: number;
  clauseCount: number;
  run: (partAtoms: readonly Atom[], st: St, ops: CompiledImpureOps, discard?: boolean) => ImpEval;
  runForEach?: ImpForEach;
}
// A compiled nondeterministic let*-chain functor (the backward-chainer class); see the section
// header above compileNondet. `run` returns every solution in clause-major depth-first order, or
// undefined to fall back (out of subset, over budget, or native stack exhaustion).
interface NondetHolder {
  kind: "nondet";
  arity: number;
  clauseCount: number;
  /** Prefer direct depth-first search when a later recursive call consumes a clause-local field
   *  produced by an earlier answer. Independent overlapping calls retain table-first evaluation. */
  preferDirectForModed: boolean;
  run: (
    env: MinEnv,
    partAtoms: readonly Atom[],
    st: St,
    ops: CompiledImpureOps,
    fuel?: number,
  ) => CompiledRunResult | undefined;
}
export type CompiledHolder =
  | FunctionalHolder
  | ScalarHolder
  | RewriteHolder
  | SymbolicHolder
  | ImperativeHolder
  | NondetHolder;
export type CompiledFns = Map<string, CompiledHolder>;
type FunctionalFns = Map<string, FunctionalHolder>;
type ValueHolder = FunctionalHolder | ScalarHolder;
type ValueFns = ReadonlyMap<string, ValueHolder>;

// A lexical scope: each in-scope variable maps to how its value is read out of the frame, plus its type.
// Replaces the old flat `string[]` of int params so a tuple-pattern parameter's elements ($t/$i/$sum) can
// resolve to element accessors on the tuple's frame slot. Constructor children use the same mechanism to
// read an Atom through a positional path in an argument slot. `len` is the current frame length (let appends).
interface ScopedValue {
  readonly acc: (f: FrameVal[]) => FrameVal;
  readonly type: Ty;
  /** The value came from below a matched constructor. In application-head position it may select one of
   *  the numeric grounded operations at runtime; every other value declines to the interpreter. */
  readonly runtimeNumericHead?: boolean;
}

interface Scope {
  vars: ReadonlyMap<string, ScopedValue>;
  len: number;
}

const ARITH: Record<string, (x: IntVal, y: IntVal) => IntVal> = {
  "+": addInt,
  "-": subInt,
  "*": mulInt,
};
const FLOAT_ARITH: Record<string, (x: number, y: number) => number> = {
  "+": (x, y) => x + y,
  "-": (x, y) => x - y,
  "*": (x, y) => x * y,
};
// Symbol heads compileBody treats as operators (so a symbol-headed expr with one of these is a call, not a
// tuple literal). A compiled function name (in `holders`) is also a call; everything else is a tuple.
const KNOWN_OPS = new Set([
  "+",
  "-",
  "*",
  "/",
  "%",
  "<",
  "<=",
  ">",
  ">=",
  "==",
  "!=",
  "if",
  "unify",
  "let",
]);

const asIntNode = (c: Compiled): IntNode => c.node as IntNode;
const asNumberNode = (c: Compiled): NumberNode => c.node as NumberNode;

type IntNode = (f: FrameVal[], runtime: FunctionalRuntime) => IntVal;
type NumberVal = IntVal | FloatVal;
type NumberNode = (f: FrameVal[], runtime: FunctionalRuntime) => NumberVal;

const isAtomFrameVal = (value: unknown): value is Atom =>
  typeof value === "object" && value !== null && "kind" in value;

const isNumberType = (type: Ty): boolean => type === "int" || type === "float" || type === "number";

function frameValueToAtom(value: FrameVal | boolean): Atom {
  if (typeof value === "boolean") return gbool(value);
  if (isAtomFrameVal(value)) return value;
  if (value instanceof FloatVal) return gfloat(value.n);
  if (value instanceof Tup) return expr(value.v.map((n) => gint(n)));
  return gint(value);
}

function numericValue(value: FrameVal | boolean): NumberVal {
  if (typeof value === "number" || typeof value === "bigint") return value;
  if (value instanceof FloatVal) return value;
  if (isAtomFrameVal(value) && value.kind === "gnd") {
    if (value.value.g === "int") return value.value.n;
    if (value.value.g === "float") return new FloatVal(value.value.n);
  }
  throw BAIL;
}

/** Coerce an Atom or a dynamic number to an int at the use site. A float always declines this path. */
function coerceCompiledInt(c: Compiled | undefined): Compiled | undefined {
  if (c === undefined) return undefined;
  if (c.type === "int") return c;
  if (c.type !== "atom" && c.type !== "number") return undefined;
  return {
    node: (frame, runtime) => {
      const value = numericValue(c.node(frame, runtime));
      if (typeof value !== "object") return value;
      throw BAIL;
    },
    type: "int",
  };
}

/** Preserve int versus float while admitting either numeric Grounded kind from a constructor slot. */
function coerceCompiledNumber(c: Compiled | undefined): Compiled | undefined {
  if (c === undefined) return undefined;
  if (isNumberType(c.type)) return c;
  if (c.type !== "atom") return undefined;
  return {
    node: (frame, runtime) => numericValue(c.node(frame, runtime)),
    type: "number",
  };
}

function compileIntBody(a: Atom, scope: Scope, holders: ValueFns): Compiled | undefined {
  return coerceCompiledInt(compileBody(a, scope, holders));
}

function compileNumberBody(a: Atom, scope: Scope, holders: ValueFns): Compiled | undefined {
  return coerceCompiledNumber(compileBody(a, scope, holders));
}

function compileArgument(
  a: Atom,
  expected: Ty,
  scope: Scope,
  holders: ValueFns,
): Compiled | undefined {
  if (expected === "int") return compileIntBody(a, scope, holders);
  if (expected === "number") return compileNumberBody(a, scope, holders);
  if (expected === "atom") return coerceForReturn(compileBody(a, scope, holders), "atom");
  return compileBody(a, scope, holders);
}

function coerceForReturn(c: Compiled | undefined, expected: Ty): Compiled | undefined {
  if (c === undefined) return undefined;
  if (expected === "atom") {
    if (c.type === "atom") return c;
    if (!isNumberType(c.type) && c.type !== "bool" && !c.type.startsWith("tuple")) return undefined;
    return {
      node: (frame, runtime) => frameValueToAtom(c.node(frame, runtime)),
      type: "atom",
    };
  }
  if (expected === "number") {
    const number = coerceCompiledNumber(c);
    return number === undefined ? undefined : { node: number.node, type: "number" };
  }
  if (expected === "int") return coerceCompiledInt(c);
  return c.type === expected ? c : undefined;
}

function mergedType(a: Ty, b: Ty): Ty | undefined {
  if (a === b) return a;
  return isNumberType(a) && isNumberType(b) ? "number" : undefined;
}

/** Compile the two operands of a binary integer operation. */
function binIntArgs(
  args: readonly Atom[],
  scope: Scope,
  holders: ValueFns,
): [IntNode, IntNode] | undefined {
  if (args.length !== 2) return undefined;
  const x = compileIntBody(args[0]!, scope, holders);
  const y = compileIntBody(args[1]!, scope, holders);
  if (!x || !y) return undefined;
  return [asIntNode(x), asIntNode(y)];
}

function binNumberArgs(
  args: readonly Atom[],
  scope: Scope,
  holders: ValueFns,
): [NumberNode, NumberNode, Ty] | undefined {
  if (args.length !== 2) return undefined;
  const x = compileNumberBody(args[0]!, scope, holders);
  const y = compileNumberBody(args[1]!, scope, holders);
  if (x === undefined || y === undefined) return undefined;
  return [asNumberNode(x), asNumberNode(y), mergedType(x.type, y.type)!];
}

function numberArithmetic(
  x: NumberVal,
  y: NumberVal,
  intOp: (a: IntVal, b: IntVal) => IntVal,
  floatOp: (a: number, b: number) => number,
): NumberVal {
  if (typeof x !== "object" && typeof y !== "object") return intOp(x, y);
  const xf = typeof x === "object" ? x.n : toF64(x);
  const yf = typeof y === "object" ? y.n : toF64(y);
  return new FloatVal(floatOp(xf, yf));
}

function compareNumberValues(x: NumberVal, y: NumberVal): number {
  if (typeof x !== "object" && typeof y !== "object") return cmpIntVal(x, y);
  const xf = typeof x === "object" ? x.n : toF64(x);
  const yf = typeof y === "object" ? y.n : toF64(y);
  if (Number.isNaN(xf) || Number.isNaN(yf)) return Number.NaN;
  return xf < yf ? -1 : xf > yf ? 1 : 0;
}

// Compile `(if cond then else)`. The condition is always a (bool) body; the branches are compiled by
// `branch`: compileBody for a body-position if, or compileTail to keep the tail calls of a tail-position
// if. Int and float branches merge to a dynamic number; other branches must share a type.
function compileIf(
  cond: Atom,
  then_: Atom,
  els: Atom,
  scope: Scope,
  holders: ValueFns,
  branch: (a: Atom) => Compiled | undefined,
): Compiled | undefined {
  const c = compileBody(cond, scope, holders);
  const t = branch(then_);
  const e = branch(els);
  if (!c || !t || !e || c.type !== "bool") return undefined;
  const type = mergedType(t.type, e.type);
  if (type === undefined) return undefined;
  const cn = c.node as (f: FrameVal[], runtime: FunctionalRuntime) => boolean;
  const tn = t.node;
  const en = e.node;
  return {
    node: (f, runtime) => {
      const condition = cn(f, runtime);
      runtime.counterDelta += 2;
      return condition ? tn(f, runtime) : en(f, runtime);
    },
    type,
  };
}

/** Compile a body atom to a typed node, or `undefined` if it falls outside the supported subset. */
function compileBody(a: Atom, scope: Scope, holders: ValueFns): Compiled | undefined {
  if (a.kind === "var") {
    const v = scope.vars.get(a.name);
    if (v === undefined) return undefined;
    return { node: v.acc, type: v.type };
  }
  if (a.kind === "gnd") {
    const v = a.value;
    if (v.g === "int") {
      const k = v.n;
      return { node: () => k, type: "int" };
    }
    if (v.g === "float") {
      const k = new FloatVal(v.n);
      return { node: () => k, type: "float" };
    }
    if (v.g === "bool") {
      const b = v.b;
      return { node: () => b, type: "bool" };
    }
    return undefined;
  }
  if (a.kind !== "expr" || a.items.length === 0) return undefined;
  // A non-operator-headed expression is a TUPLE literal: `((+ $t 1) 1 (+ $sum (* $t $i)))`. Each element
  // must compile to an int; the node builds a Tup. (An operator/function call has a symbol head handled
  // below; a tuple's head is a non-symbol, or a symbol that is neither a known op nor a compiled function.)
  const head = a.items[0]!;
  if (head.kind === "var" && scope.vars.get(head.name)?.runtimeNumericHead === true) {
    const opValue = scope.vars.get(head.name)!;
    const xy = binNumberArgs(a.items.slice(1), scope, holders);
    if (xy === undefined) return undefined;
    const [xn, yn, type] = xy;
    return {
      node: (frame, runtime) => {
        const selected = opValue.acc(frame);
        if (
          !isAtomFrameVal(selected) ||
          selected.kind !== "sym" ||
          (selected.name !== "+" && selected.name !== "-" && selected.name !== "*")
        )
          throw BAIL;
        return numberArithmetic(
          xn(frame, runtime),
          yn(frame, runtime),
          ARITH[selected.name]!,
          FLOAT_ARITH[selected.name]!,
        );
      },
      type,
    };
  }
  const isCall = head.kind === "sym" && (KNOWN_OPS.has(head.name) || holders.has(head.name));
  if (!isCall) {
    const elems = a.items.map((e) => compileBody(e, scope, holders));
    if (elems.some((c) => !c || c.type !== "int")) return undefined;
    const ns = elems.map((c) => asIntNode(c!));
    return {
      node: (f, runtime) => new Tup(ns.map((n) => n(f, runtime))),
      type: `tuple${a.items.length}`,
    };
  }
  const op = (head as { name: string }).name;
  const args = a.items.slice(1);

  if (op === "+" || op === "-" || op === "*") {
    const xy = binNumberArgs(args, scope, holders);
    if (!xy) return undefined;
    const [xn, yn, type] = xy;
    return {
      node: (fr, runtime) =>
        numberArithmetic(xn(fr, runtime), yn(fr, runtime), ARITH[op]!, FLOAT_ARITH[op]!),
      type,
    };
  }
  if (op === "/") {
    const xy = binNumberArgs(args, scope, holders);
    if (!xy) return undefined;
    const [xn, yn, type] = xy;
    return {
      node: (fr, runtime) => {
        const divisor = yn(fr, runtime);
        if (typeof divisor !== "object" && isZero(divisor)) throw BAIL;
        return numberArithmetic(xn(fr, runtime), divisor, intDiv, (x, y) => x / y);
      },
      type,
    };
  }
  if (op === "%") {
    const xy = binIntArgs(args, scope, holders);
    if (!xy) return undefined;
    const [xn, yn] = xy;
    return {
      node: (fr, runtime) => {
        const d = yn(fr, runtime);
        if (isZero(d)) throw BAIL; // interpreter builds the exact DivisionByZero error
        return intMod(xn(fr, runtime), d);
      },
      type: "int",
    };
  }
  if (op === "<" || op === "<=" || op === ">" || op === ">=" || op === "==" || op === "!=") {
    const xy = binNumberArgs(args, scope, holders);
    if (!xy) return undefined;
    const [xn, yn] = xy;
    const test =
      op === "<"
        ? (c: number) => c < 0
        : op === "<="
          ? (c: number) => c <= 0
          : op === ">"
            ? (c: number) => c > 0
            : op === ">="
              ? (c: number) => c >= 0
              : op === "=="
                ? (c: number) => c === 0
                : (c: number) => c !== 0;
    return {
      node: (fr, runtime) => test(compareNumberValues(xn(fr, runtime), yn(fr, runtime))),
      type: "bool",
    };
  }
  if (op === "if") {
    if (args.length !== 3) return undefined;
    return compileIf(args[0]!, args[1]!, args[2]!, scope, holders, (x) =>
      compileBody(x, scope, holders),
    );
  }
  if (op === "unify") {
    // (unify <x> <ground-number-literal> <then> <else>) with no new binding becomes equality.
    if (args.length !== 4) return undefined;
    const pat = args[1]!;
    if (!(pat.kind === "gnd" && (pat.value.g === "int" || pat.value.g === "float")))
      return undefined;
    const patVal: NumberVal = pat.value.g === "int" ? pat.value.n : new FloatVal(pat.value.n);
    const x = compileNumberBody(args[0]!, scope, holders);
    const t = compileBody(args[2]!, scope, holders);
    const e = compileBody(args[3]!, scope, holders);
    if (!x || !t || !e) return undefined;
    const type = mergedType(t.type, e.type);
    if (type === undefined) return undefined;
    const xn = asNumberNode(x);
    const tn = t.node;
    const en = e.node;
    return {
      node: (fr, runtime) =>
        compareNumberValues(xn(fr, runtime), patVal) === 0 ? tn(fr, runtime) : en(fr, runtime),
      type,
    };
  }
  if (op === "let") {
    // (let <var> <number-value> <body>) binds the variable, then evaluates the body.
    // In MeTTa `let` desugars to `(unify value var body Empty)`; a variable pattern always binds, so
    // the body always runs with the deterministic numeric value.
    if (args.length !== 3 || args[0]!.kind !== "var") return undefined;
    const val = compileNumberBody(args[1]!, scope, holders);
    if (!val) return undefined;
    const idx = scope.len;
    const np: Scope = {
      vars: new Map(scope.vars).set((args[0] as { name: string }).name, {
        acc: (f) => f[idx]!,
        type: val.type,
      }),
      len: scope.len + 1,
    };
    const body = compileBody(args[2]!, np, holders);
    if (!body) return undefined;
    const vn = val.node;
    const bn = body.node;
    return {
      node: (fr, runtime) => {
        const next = [...fr, vn(fr, runtime) as FrameVal];
        runtime.counterDelta += 1;
        return bn(next, runtime);
      },
      type: body.type,
    };
  }
  // a call to another compiled function (self or mutual): each argument must match the callee's declared
  // parameter type (int or tuple), so a tuple flows through a call faithfully.
  const h = holders.get(op);
  if (h !== undefined) {
    if (args.length !== h.arity) return undefined;
    const cs = args.map((ar, i) => compileArgument(ar, h.paramTypes[i]!, scope, holders));
    if (cs.some((c, i) => !c || c.type !== h.paramTypes[i])) return undefined;
    const ns = cs.map((c) => c!.node);
    // args are int/tuple (paramTypes never bool), so the mapped values are FrameVal.
    return {
      node: (fr, runtime) => h.run(ns.map((n) => n(fr, runtime)) as FrameVal[], runtime),
      type: h.retType,
    };
  }
  return undefined;
}

function compileTailSelfCall(
  a: Atom,
  scope: Scope,
  holders: ValueFns,
  self: string,
): Compiled | undefined {
  if (
    a.kind !== "expr" ||
    a.items.length === 0 ||
    a.items[0]!.kind !== "sym" ||
    a.items[0]!.name !== self
  )
    return undefined;
  const h = holders.get(self);
  if (h === undefined || a.items.length - 1 !== h.arity) return undefined;
  const cs = a.items.slice(1).map((x, i) => compileArgument(x, h.paramTypes[i]!, scope, holders));
  if (cs.some((c, i) => !c || c.type !== h.paramTypes[i])) return undefined;
  const ns = cs.map((c) => c!.node);
  return {
    node: (f, runtime) => ns.map((n) => n(f, runtime)) as unknown as FrameVal,
    type: h.retType,
  };
}

/** Compile a body atom in TAIL position. A self-call there returns the next argument frame (an array) for
 *  the caller's loop to consume instead of recursing, and an `if`'s branches stay in tail position. Anything
 *  else compiles normally via `compileBody` (so a non-tail self-call, e.g. fib's, stays ordinary recursion).
 *  This turns a tail-recursive function (find-divisor's trial-division loop is the motivating case) into a
 *  native while-loop in `makeRun`, instead of deep recursion that V8 deoptimises (measured 8x slower than
 *  the interpreter on a deep loop). The array sentinel is unambiguous because a real scalar result is never
 *  an array. */
function compileTail(
  a: Atom,
  scope: Scope,
  holders: ValueFns,
  self: string,
  expected?: Ty,
): Compiled | undefined {
  if (a.kind === "expr" && a.items.length > 0 && a.items[0]!.kind === "sym") {
    const op = (a.items[0] as { name: string }).name;
    if (op === "if" && a.items.length === 4) {
      return compileIf(a.items[1]!, a.items[2]!, a.items[3]!, scope, holders, (x) =>
        compileTail(x, scope, holders, self, expected),
      );
    }
    if (op === "let" && a.items.length === 4 && a.items[1]!.kind === "var") {
      const value = compileNumberBody(a.items[2]!, scope, holders);
      if (value === undefined) return undefined;
      const idx = scope.len;
      const nextScope: Scope = {
        vars: new Map(scope.vars).set(a.items[1]!.name, {
          acc: (frame) => frame[idx]!,
          type: value.type,
        }),
        len: idx + 1,
      };
      const body = compileTail(a.items[3]!, nextScope, holders, self, expected);
      if (body === undefined) return undefined;
      const valueNode = value.node;
      return {
        node: (frame, runtime) => {
          const next = [...frame, valueNode(frame, runtime) as FrameVal];
          runtime.counterDelta += 1;
          return body.node(next, runtime);
        },
        type: body.type,
      };
    }
    if (op === self) {
      const tailCall = compileTailSelfCall(a, scope, holders, self);
      if (tailCall !== undefined) return tailCall;
    }
  }
  const body = compileBody(a, scope, holders);
  return expected === undefined ? body : coerceForReturn(body, expected);
}

const bailRun = (): FrameVal | boolean => {
  throw BAIL;
};

/** How many times `functor` is applied inside `body`. Tree recursion (>=2 self-calls, e.g. fib) has
 *  overlapping subproblems that memoisation collapses from exponential to polynomial; a single tail call
 *  (find-divisor's trial-division loop) has no overlap, so memoising it only grows an unbounded cache of
 *  never-repeated keys, which made primality testing 875x slower per 10x of work. */
function selfCallCount(a: Atom, functor: string): number {
  if (a.kind !== "expr" || a.items.length === 0) return 0;
  let n = a.items[0]!.kind === "sym" && (a.items[0] as { name: string }).name === functor ? 1 : 0;
  for (const it of a.items) n += selfCallCount(it, functor);
  return n;
}

/** Wrap a compiled body node in per-call memoisation (the function is pure, so the result is a function of
 *  its arguments). Only tree-recursive functions are memoised; a non- or tail-recursive function gains
 *  nothing from the cache and pays the key-building and Map cost on every call, so it runs bare. Single-int
 *  -arg functions key directly; others by a string of args. */
function makeRun(
  name: string,
  arity: number,
  node: Node,
  memoize: boolean,
  handoffDepth = EVALUATION_TRAMPOLINE_DEPTH,
): FunctionalHolder["run"] {
  // A tail-recursive body (compiled by compileTail) returns the next argument frame as an array; loop on it
  // instead of recursing. A non-tail-recursive body never returns an array, so the loop runs exactly once.
  // (`Tup` and Atom results are objects, not arrays, so neither is mistaken for a tail-call frame.)
  const loop = (vals: FrameVal[], runtime: FunctionalRuntime): FrameVal | boolean => {
    let frame = vals;
    let first = true;
    for (;;) {
      if (first) first = false;
      else runtime.counterDelta += 1;
      if (runtime.counterLimit !== undefined && runtime.counterDelta > runtime.counterLimit)
        throw BAIL;
      const r: unknown = node(frame, runtime);
      if (Array.isArray(r)) {
        frame = r as FrameVal[];
        continue;
      }
      return r as FrameVal | boolean;
    }
  };
  const memo = memoize
    ? new Map<
        unknown,
        { readonly value: FrameVal | boolean; readonly span: number; readonly counterSpan: number }
      >()
    : undefined;
  // A tuple argument must be keyed by its contents, not `String(tup)` (which is "[object Object]" for every
  // tuple and so collapses distinct tuples in the same position to one (a stale memo hit). Numbers key as
  // themselves; an int and a bigint of equal value share a key, which is a correct hit (same value). Scalar
  // Atom frames are never memoised; throwing here makes an accidental future use decline instead of aliasing
  // distinct constructor inputs.
  const keyOf = (v: FrameVal): string => {
    if (isAtomFrameVal(v) || v instanceof FloatVal) throw BAIL;
    return v instanceof Tup ? "(" + v.v.map(keyOf).join(" ") + ")" : String(v);
  };
  return (vals, inherited, entered = false) => {
    const runtime = inherited ?? {
      depth: new EvaluationDepth(),
      limit: 0,
      counterBase: 0,
      counterLimit: undefined,
      counterDelta: 0,
      freshSuffix: "",
    };
    if (!entered) {
      const boundary = runtime.depth.enterBoundary(runtime.limit, handoffDepth);
      if (boundary !== undefined)
        throwEvaluationDepthBoundary(boundary, expr([sym(name), ...vals.map(frameValueToAtom)]));
    }
    try {
      runtime.counterDelta += 1;
      if (memo === undefined) return loop(vals, runtime);
      const key = arity === 1 ? keyOf(vals[0]!) : vals.map(keyOf).join(",");
      const hit = memo.get(key);
      if (hit !== undefined && runtime.depth.canReplay(hit.span, runtime.limit)) {
        runtime.depth.replay(hit.span);
        runtime.counterDelta += hit.counterSpan;
        return hit.value;
      }
      const marker = runtime.depth.beginSpan();
      const counterStart = runtime.counterDelta;
      try {
        const value = loop(vals, runtime);
        const span = runtime.depth.endSpan(marker);
        memo.set(key, { value, span, counterSpan: runtime.counterDelta - counterStart });
        return value;
      } catch (error) {
        runtime.depth.endSpan(marker);
        throw error;
      }
    } finally {
      if (!entered) runtime.depth.leave();
    }
  };
}

// A parameter is either a plain variable or a flat tuple-of-variables pattern `($t $i $sum)`.
type ParamPat = string | string[];

/** A single-clause `(= (f $a ($x $y) ...) body)` whose parameters are distinct variables or flat tuple
 *  patterns, or undefined. */
function singleClauseHead(
  env: MinEnv,
  functor: string,
): { params: ParamPat[]; body: Atom } | undefined {
  const eqs = env.ruleIndex.get(functor);
  if (eqs === undefined || eqs.length !== 1) return undefined;
  const [lhs, body] = eqs[0]!;
  if (lhs.kind !== "expr" || lhs.items.length === 0 || lhs.items[0]!.kind !== "sym")
    return undefined;
  const params: ParamPat[] = [];
  const seen = new Set<string>();
  const take = (name: string): boolean => (seen.has(name) ? false : (seen.add(name), true));
  for (let i = 1; i < lhs.items.length; i++) {
    const it = lhs.items[i]!;
    if (it.kind === "var") {
      if (!take(it.name)) return undefined;
      params.push(it.name);
    } else if (
      it.kind === "expr" &&
      it.items.length > 0 &&
      it.items.every((e) => e.kind === "var")
    ) {
      const elems = it.items.map((e) => (e as { name: string }).name);
      if (!elems.every(take)) return undefined;
      params.push(elems);
    } else return undefined;
  }
  return { params, body };
}

/** Build the lexical scope a function body compiles against, using each parameter's resolved type: a plain
 *  var reads its frame slot (its type may be a tuple, inferred from usage); a tuple pattern's elements read
 *  into the tuple sitting in that slot. */
function buildScope(params: readonly ParamPat[], paramTypes: readonly Ty[]): Scope {
  const vars = new Map<string, ScopedValue>();
  params.forEach((p, i) => {
    if (typeof p === "string") vars.set(p, { acc: (f) => f[i]!, type: paramTypes[i]! });
    else p.forEach((e, j) => vars.set(e, { acc: (f) => (f[i] as Tup).v[j]!, type: "int" }));
  });
  return { vars, len: params.length };
}

/** Map of every variable a parameter list binds to its type, for inferType (tuple elements are int). */
function varTypesOf(params: readonly ParamPat[], paramTypes: readonly Ty[]): Map<string, Ty> {
  const m = new Map<string, Ty>();
  params.forEach((p, i) => {
    if (typeof p === "string") m.set(p, paramTypes[i]!);
    else p.forEach((e) => m.set(e, "int"));
  });
  return m;
}

/** Initial parameter types before usage refinement: a plain var defaults to int, a tuple pattern is its
 *  arity. A plain var that actually holds a tuple is upgraded by inferVarType. */
const paramTypesOf = (params: readonly ParamPat[]): Ty[] =>
  params.map((p) => (typeof p === "string" ? "int" : (`tuple${p.length}` as Ty)));

/** Infer a plain-var parameter's type from its first use as an argument to a compiled function: if it is
 *  passed where that function expects a tuple, it is that tuple type. Returns undefined if only used as int. */
function inferVarType(body: Atom, name: string, holders: FunctionalFns): Ty | undefined {
  let found: Ty | undefined;
  const walk = (a: Atom): void => {
    if (found !== undefined || a.kind !== "expr" || a.items.length === 0) return;
    if (a.items[0]!.kind === "sym") {
      const h = holders.get((a.items[0] as { name: string }).name);
      if (h !== undefined)
        for (let i = 0; i + 1 < a.items.length && found === undefined; i++) {
          const arg = a.items[i + 1]!;
          if (arg.kind === "var" && arg.name === name && h.paramTypes[i] !== "int")
            found = h.paramTypes[i];
        }
    }
    for (const it of a.items) walk(it);
  };
  walk(body);
  return found;
}

type Cand = Map<string, { params: ParamPat[]; body: Atom }>;

/** Infer a body's return type, optimistically over recursion (an `if`/`unify` types from whichever
 *  branch is already known). Returns undefined when not yet determinable; the strict `compileBody`
 *  pass later rejects any function whose branches actually disagree, so optimism here is safe. */
function inferType(
  a: Atom,
  varTypes: ReadonlyMap<string, Ty>,
  holders: FunctionalFns,
): Ty | undefined {
  if (a.kind === "var") return varTypes.get(a.name);
  if (a.kind === "gnd")
    return a.value.g === "int"
      ? "int"
      : a.value.g === "float"
        ? "float"
        : a.value.g === "bool"
          ? "bool"
          : undefined;
  if (a.kind !== "expr" || a.items.length === 0) return undefined;
  // A non-operator-headed expression is a tuple literal; its type is `tuple<n>` if every element is int.
  const hd = a.items[0]!;
  if (!(hd.kind === "sym" && (KNOWN_OPS.has(hd.name) || holders.has(hd.name))))
    return a.items.every((e) => inferType(e, varTypes, holders) === "int")
      ? `tuple${a.items.length}`
      : undefined;
  const op = (hd as { name: string }).name;
  if (op === "+" || op === "-" || op === "*" || op === "/") {
    if (a.items.length !== 3) return undefined;
    const left = inferType(a.items[1]!, varTypes, holders);
    const right = inferType(a.items[2]!, varTypes, holders);
    if (left !== undefined && !isNumberType(left)) return undefined;
    if (right !== undefined && !isNumberType(right)) return undefined;
    return mergedType(left ?? "int", right ?? "int");
  }
  if (op === "%") return "int";
  if (op === "<" || op === "<=" || op === ">" || op === ">=" || op === "==" || op === "!=")
    return "bool";
  if (op === "if" && a.items.length === 4) {
    const tt = inferType(a.items[2]!, varTypes, holders);
    const te = inferType(a.items[3]!, varTypes, holders);
    if (tt !== undefined && te !== undefined) return mergedType(tt, te);
    return tt ?? te;
  }
  if (op === "unify" && a.items.length === 5) {
    const tt = inferType(a.items[3]!, varTypes, holders);
    const te = inferType(a.items[4]!, varTypes, holders);
    if (tt !== undefined && te !== undefined) return mergedType(tt, te);
    return tt ?? te;
  }
  if (op === "let" && a.items.length === 4) return inferType(a.items[3]!, varTypes, holders); // body's type
  return holders.get(op)?.retType; // a call: its inferred return type, if known yet
}

type RewriteCellPat = { tag: "sym"; atom: SymAtom } | { tag: "var"; name: string };
type RewriteArgPat =
  | { tag: "sym"; atom: SymAtom }
  | { tag: "tuple"; items: readonly RewriteCellPat[] };
type RewriteOut = { tag: "sym"; atom: SymAtom } | { tag: "var"; name: string };
type RewriteArgVal =
  | { tag: "sym"; atom: SymAtom }
  | { tag: "tuple"; items: readonly SymAtom[] }
  | { tag: "qvar"; name: string };
interface RewriteRule {
  readonly args: readonly RewriteArgPat[];
  readonly out: readonly RewriteOut[];
  readonly vars: ReadonlyMap<string, { arg: number; cell: number }>;
}

function compileRewriteCellPat(a: Atom, seen: Set<string>): RewriteCellPat | undefined {
  if (a.kind === "sym") return { tag: "sym", atom: a };
  if (a.kind !== "var" || seen.has(a.name)) return undefined;
  seen.add(a.name);
  return { tag: "var", name: a.name };
}

function compileRewriteArgPat(a: Atom, seen: Set<string>): RewriteArgPat | undefined {
  if (a.kind === "sym") return { tag: "sym", atom: a };
  if (a.kind !== "expr" || a.items.length === 0) return undefined;
  const items = a.items.map((it) => compileRewriteCellPat(it, seen));
  if (items.some((it) => it === undefined)) return undefined;
  return { tag: "tuple", items: items as RewriteCellPat[] };
}

function compileRewriteOut(a: Atom, vars: ReadonlySet<string>): RewriteOut[] | undefined {
  if (a.kind !== "expr" || a.items.length === 0) return undefined;
  const out: RewriteOut[] = [];
  for (const it of a.items) {
    if (it.kind === "sym") out.push({ tag: "sym", atom: it });
    else if (it.kind === "var" && vars.has(it.name)) out.push({ tag: "var", name: it.name });
    else return undefined;
  }
  return out;
}

function capturePositions(
  args: readonly RewriteArgPat[],
): ReadonlyMap<string, { arg: number; cell: number }> {
  const vars = new Map<string, { arg: number; cell: number }>();
  args.forEach((arg, i) => {
    if (arg.tag === "tuple")
      arg.items.forEach((cell, j) => {
        if (cell.tag === "var") vars.set(cell.name, { arg: i, cell: j });
      });
  });
  return vars;
}

function rewriteParamTypes(args: readonly RewriteArgPat[]): Ty[] {
  return args.map((arg) => (arg.tag === "sym" ? "sym" : (`symtuple${arg.items.length}` as Ty)));
}

function sameRewriteParamType(arg: RewriteArgPat, type: Ty): boolean {
  if (type === "sym") return arg.tag === "sym";
  if (!type.startsWith("symtuple") || arg.tag !== "tuple") return false;
  return arg.items.length === Number(type.slice("symtuple".length));
}

function atomToRewriteArg(a: Atom, type: Ty): RewriteArgVal | undefined {
  if (type === "sym") {
    if (a.kind === "sym") return { tag: "sym", atom: a };
    if (a.kind === "var") return { tag: "qvar", name: a.name };
    return undefined;
  }
  if (!type.startsWith("symtuple") || a.kind !== "expr") return undefined;
  const width = Number(type.slice("symtuple".length));
  if (a.items.length !== width) return undefined;
  const items: SymAtom[] = [];
  for (const it of a.items) {
    if (it.kind !== "sym") return undefined;
    items.push(it);
  }
  return { tag: "tuple", items };
}

function bindQueryVar(b: Bindings, name: string, atom: SymAtom): Bindings | undefined {
  for (const rel of b) {
    if (rel.tag === "val" && rel.x === name) return rel.a === atom ? b : undefined;
  }
  return prependValRaw(b, name, atom);
}

function runRewriteRule(
  rule: RewriteRule,
  vals: readonly RewriteArgVal[],
): CompiledAtomResult | undefined {
  let b = emptyBindings;
  for (let i = 0; i < rule.args.length; i++) {
    const pat = rule.args[i]!;
    const actual = vals[i]!;
    if (pat.tag === "sym") {
      if (actual.tag === "sym") {
        if (actual.atom !== pat.atom) return undefined;
      } else if (actual.tag === "qvar") {
        const nb = bindQueryVar(b, actual.name, pat.atom);
        if (nb === undefined) return undefined;
        b = nb;
      } else return undefined;
      continue;
    }
    if (actual.tag !== "tuple" || actual.items.length !== pat.items.length) return undefined;
    for (let j = 0; j < pat.items.length; j++) {
      const cell = pat.items[j]!;
      if (cell.tag === "sym" && actual.items[j] !== cell.atom) return undefined;
    }
  }
  const out = rule.out.map((part) => {
    if (part.tag === "sym") return part.atom;
    const pos = rule.vars.get(part.name)!;
    return (vals[pos.arg] as { items: readonly SymAtom[] }).items[pos.cell]!;
  });
  return { atom: expr(out), bnd: b };
}

function compileRewrite(env: MinEnv, functor: string): RewriteHolder | undefined {
  const eqs = env.ruleIndex.get(functor);
  if (eqs === undefined || eqs.length === 0) return undefined;
  const rules: RewriteRule[] = [];
  let arity: number | undefined;
  let retType: Ty | undefined;
  let paramTypes: Ty[] | undefined;
  for (const [lhs, rhs] of eqs) {
    if (lhs.kind !== "expr" || lhs.items.length === 0 || lhs.items[0]!.kind !== "sym")
      return undefined;
    if (lhs.items[0]!.name !== functor) return undefined;
    arity ??= lhs.items.length - 1;
    if (lhs.items.length - 1 !== arity) return undefined;
    const seen = new Set<string>();
    const args = lhs.items.slice(1).map((arg) => compileRewriteArgPat(arg, seen));
    if (args.some((arg) => arg === undefined)) return undefined;
    const typedArgs = args as RewriteArgPat[];
    if (paramTypes === undefined) paramTypes = rewriteParamTypes(typedArgs);
    else if (
      typedArgs.length !== paramTypes.length ||
      typedArgs.some((arg, i) => !sameRewriteParamType(arg, paramTypes![i]!))
    )
      return undefined;
    const vars = capturePositions(typedArgs);
    const out = compileRewriteOut(rhs, new Set(vars.keys()));
    if (out === undefined) return undefined;
    const rt = `symtuple${out.length}` as Ty;
    if (retType === undefined) retType = rt;
    else if (retType !== rt) return undefined;
    rules.push({ args: typedArgs, out, vars });
  }
  if (arity === undefined || retType === undefined || paramTypes === undefined) return undefined;
  const run = (partAtoms: readonly Atom[]): CompiledRunResult | undefined => {
    const vals: RewriteArgVal[] = [];
    const qvars = new Set<string>();
    for (let i = 0; i < partAtoms.length; i++) {
      const v = atomToRewriteArg(partAtoms[i]!, paramTypes![i]!);
      if (v === undefined) return undefined;
      if (v.tag === "qvar") {
        if (qvars.has(v.name)) return undefined;
        qvars.add(v.name);
      }
      vals.push(v);
    }
    const results: CompiledAtomResult[] = [];
    for (const rule of rules) {
      const r = runRewriteRule(rule, vals);
      if (r !== undefined) results.push(r);
    }
    return results.length === 0 ? undefined : { results, counterDelta: rules.length };
  };
  return { kind: "rewrite", arity, retType, paramTypes, ruleCount: rules.length, run };
}

// ---------- general symbolic constructor rewrites ----------

// A compiled LHS pattern, matched positionally against a ground argument. A NEW variable takes the next
// slot (left-linear: a repeated variable bails the whole functor, since slot binding alone cannot enforce
// the equality the interpreter's matcher would).
type SymPat =
  | { readonly tag: "sym"; readonly name: string }
  | { readonly tag: "slot"; readonly slot: number }
  | { readonly tag: "lit"; readonly atom: Atom }
  | { readonly tag: "expr"; readonly items: readonly SymPat[] };

// A compiled RHS template, built directly from the matched slots. A `fresh` is an RHS-only variable that
// becomes `$name#<suffix>` exactly as `instantiate` would render an unbound suffixed variable.
type SymTpl =
  | { readonly tag: "atom"; readonly atom: Atom }
  | { readonly tag: "slot"; readonly slot: number }
  | { readonly tag: "fresh"; readonly name: string }
  | { readonly tag: "expr"; readonly items: readonly SymTpl[] };

interface SymClause {
  readonly pats: readonly SymPat[];
  readonly tpl: SymTpl;
  readonly nslots: number;
}

/** Compile an LHS pattern, assigning each new variable the next slot. Returns undefined for a repeated
 *  variable (non-left-linear) so the whole functor falls back to the interpreter. */
function compileSymPat(a: Atom, slots: Map<string, number>): SymPat | undefined {
  if (a.kind === "sym") return { tag: "sym", name: a.name };
  if (a.kind === "var") {
    if (slots.has(a.name)) return undefined;
    const slot = slots.size;
    slots.set(a.name, slot);
    return { tag: "slot", slot };
  }
  if (a.kind === "gnd") return { tag: "lit", atom: a };
  const items: SymPat[] = [];
  for (const it of a.items) {
    const p = compileSymPat(it, slots);
    if (p === undefined) return undefined;
    items.push(p);
  }
  return { tag: "expr", items };
}

/** Compile an RHS into a template. A variable bound by the LHS becomes a slot read; an RHS-only variable
 *  becomes a fresh suffixed variable at build time. Ground leaves are carried as-is. */
function compileSymTpl(a: Atom, slots: ReadonlyMap<string, number>): SymTpl {
  if (a.kind === "var") {
    const slot = slots.get(a.name);
    return slot === undefined ? { tag: "fresh", name: a.name } : { tag: "slot", slot };
  }
  if (a.kind !== "expr") return { tag: "atom", atom: a };
  return { tag: "expr", items: a.items.map((it) => compileSymTpl(it, slots)) };
}

/** Match a compiled pattern against a ground argument. Symbolic rewrites pass `slots` to capture variables;
 *  scalar dispatch omits it because clause scopes read constructor children directly from the input frame. */
function matchSymPat(pat: SymPat, arg: Atom, slots?: Atom[]): boolean {
  switch (pat.tag) {
    case "sym":
      return arg.kind === "sym" && arg.name === pat.name;
    case "slot":
      if (slots !== undefined) slots[pat.slot] = arg;
      return true;
    case "lit":
      return atomEq(arg, pat.atom);
    case "expr": {
      if (arg.kind !== "expr" || arg.items.length !== pat.items.length) return false;
      for (let i = 0; i < pat.items.length; i++)
        if (!matchSymPat(pat.items[i]!, arg.items[i]!, slots)) return false;
      return true;
    }
  }
}

function bindSymQueryVar(bs: readonly Bindings[], name: string, value: Atom): Bindings[] {
  const out: Bindings[] = [];
  for (const b of bs) for (const ext of addVarBinding(b, name, value)) out.push(ext);
  return out;
}

function matchSymPatQuery(
  pat: SymPat,
  arg: Atom,
  slots: Atom[],
  bs: readonly Bindings[],
): Bindings[] | undefined {
  switch (pat.tag) {
    case "sym":
      if (arg.kind === "var") return bindSymQueryVar(bs, arg.name, sym(pat.name));
      return arg.kind === "sym" && arg.name === pat.name ? [...bs] : [];
    case "slot":
      slots[pat.slot] = arg;
      return [...bs];
    case "lit":
      if (arg.kind === "var") return bindSymQueryVar(bs, arg.name, pat.atom);
      return atomEq(arg, pat.atom) ? [...bs] : [];
    case "expr": {
      if (arg.kind === "var") return undefined;
      if (arg.kind !== "expr" || arg.items.length !== pat.items.length) return [];
      let cur = [...bs];
      for (let i = 0; i < pat.items.length; i++) {
        const next = matchSymPatQuery(pat.items[i]!, arg.items[i]!, slots, cur);
        if (next === undefined) return undefined;
        if (next.length === 0) return [];
        cur = next;
      }
      return cur;
    }
  }
}

/** Build an RHS template into an atom. `expr()` recomputes the ground flag exactly as `instantiate`'s
 *  rebuild does, so a result carrying a fresh variable is correctly non-ground. */
function buildSymTpl(tpl: SymTpl, slots: readonly Atom[], suffix: string): Atom {
  switch (tpl.tag) {
    case "atom":
      return tpl.atom;
    case "slot":
      return slots[tpl.slot]!;
    case "fresh":
      return variable(tpl.name + suffix);
    case "expr":
      return expr(tpl.items.map((t) => buildSymTpl(t, slots, suffix)));
  }
}

/** Compile a pure functor whose every static clause is a left-linear constructor rewrite. Sound only when
 *  `candidatesW` for a symbol-headed call equals exactly the static clauses: no `($x ...)`-headed catch-all
 *  rules participate (varRulesVar empty), and the eval call site declines when runtime rules can affect
 *  the operator. Query variables in call arguments are handled by binding them to the compiled pattern
 *  leaves, which keeps calls like tilepuzzle's `(move $state $_)` on the compiled path. */
function compileSymbolic(env: MinEnv, functor: string): SymbolicHolder | undefined {
  if (env.varRulesVar.length !== 0) return undefined;
  const eqs = env.ruleIndex.get(functor);
  if (eqs === undefined || eqs.length === 0) return undefined;
  const clauses: SymClause[] = [];
  let arity: number | undefined;
  for (const [lhs, rhs] of eqs) {
    if (lhs.kind !== "expr" || lhs.items.length === 0) return undefined;
    if (lhs.items[0]!.kind !== "sym" || lhs.items[0]!.name !== functor) return undefined;
    const a = lhs.items.length - 1;
    if (arity === undefined) arity = a;
    else if (a !== arity) return undefined;
    const slots = new Map<string, number>();
    const pats: SymPat[] = [];
    for (let i = 1; i < lhs.items.length; i++) {
      const p = compileSymPat(lhs.items[i]!, slots);
      if (p === undefined) return undefined;
      pats.push(p);
    }
    clauses.push({ pats, tpl: compileSymTpl(rhs, slots), nslots: slots.size });
  }
  if (arity === undefined) return undefined;
  const clauseCount = clauses.length;
  const run = (partAtoms: readonly Atom[], counter: number): CompiledRunResult | undefined => {
    const results: CompiledAtomResult[] = [];
    for (let i = 0; i < clauseCount; i++) {
      const clause = clauses[i]!;
      const slots: Atom[] = new Array(clause.nslots);
      let bnds: Bindings[] = [emptyBindings];
      for (let j = 0; j < clause.pats.length; j++) {
        if (partAtoms[j]!.ground) {
          if (!matchSymPat(clause.pats[j]!, partAtoms[j]!, slots)) {
            bnds = [];
            break;
          }
          continue;
        }
        const next = matchSymPatQuery(clause.pats[j]!, partAtoms[j]!, slots, bnds);
        if (next === undefined) return undefined;
        bnds = next;
        if (bnds.length === 0) break;
      }
      if (bnds.length > 0) {
        const atom = buildSymTpl(clause.tpl, slots, "#" + (counter + i));
        for (const bnd of bnds)
          results.push({
            atom,
            bnd,
          });
      }
    }
    return results.length === 0 ? undefined : { results, counterDelta: clauseCount };
  };
  return { kind: "symbolic", arity, clauseCount, run };
}

// ---------- deterministic scalar constructor dispatch ----------

interface ScalarSlotPosition {
  readonly arg: number;
  readonly path: readonly number[];
}

interface ScalarClauseCandidate {
  readonly pats: readonly SymPat[];
  readonly slots: ReadonlyMap<string, number>;
  readonly positions: readonly ScalarSlotPosition[];
  readonly body: Atom;
  readonly mayNeedFreshSuffix: boolean;
}

interface ScalarCandidate {
  readonly arity: number;
  readonly clauses: readonly ScalarClauseCandidate[];
  readonly declaredReturn: "number" | undefined;
}

type ScalarDiscriminant =
  | { readonly tag: "sym"; readonly name: string }
  | { readonly tag: "lit"; readonly atom: Atom }
  | { readonly tag: "ctor"; readonly name: string; readonly arity: number };

/** A top-level pattern discriminant. A variable, an empty expression, or a non-symbol-headed expression is
 *  unknown. Treating unknown as overlapping is conservative and keeps scalar dispatch sound. */
function scalarDiscriminant(pat: SymPat): ScalarDiscriminant | undefined {
  if (pat.tag === "sym") return { tag: "sym", name: pat.name };
  if (pat.tag === "lit") return { tag: "lit", atom: pat.atom };
  if (pat.tag !== "expr" || pat.items.length === 0 || pat.items[0]!.tag !== "sym") return undefined;
  return { tag: "ctor", name: pat.items[0]!.name, arity: pat.items.length - 1 };
}

function scalarDiscriminantsEqual(a: ScalarDiscriminant, b: ScalarDiscriminant): boolean {
  if (a.tag !== b.tag) return false;
  if (a.tag === "lit" && b.tag === "lit") return atomEq(a.atom, b.atom);
  if (a.tag === "sym" && b.tag === "sym") return a.name === b.name;
  return a.tag === "ctor" && b.tag === "ctor" && a.name === b.name && a.arity === b.arity;
}

/** Two clause heads are disjoint when some argument position has concrete unequal discriminants. Deeper
 *  differences under the same constructor do not prove disjointness in this first increment. */
function scalarClausesDisjoint(a: ScalarClauseCandidate, b: ScalarClauseCandidate): boolean {
  for (let i = 0; i < a.pats.length; i++) {
    const ad = scalarDiscriminant(a.pats[i]!);
    const bd = scalarDiscriminant(b.pats[i]!);
    if (ad !== undefined && bd !== undefined && !scalarDiscriminantsEqual(ad, bd)) return true;
  }
  return false;
}

function collectScalarSlotPositions(
  pat: SymPat,
  arg: number,
  path: readonly number[],
  positions: ScalarSlotPosition[],
): void {
  if (pat.tag === "slot") {
    positions[pat.slot] = { arg, path };
    return;
  }
  if (pat.tag !== "expr") return;
  for (let i = 0; i < pat.items.length; i++)
    collectScalarSlotPositions(pat.items[i]!, arg, [...path, i], positions);
}

function hasVariableOutsideSlots(atom: Atom, slots: ReadonlyMap<string, number>): boolean {
  if (atom.kind === "var") return !slots.has(atom.name);
  return atom.kind === "expr" && atom.items.some((item) => hasVariableOutsideSlots(item, slots));
}

const scalarDeclaredReturn = (name: string): "number" | undefined =>
  NUMBER_FAMILY_TYPE_NAMES.has(name) ? "number" : undefined;

/** Analyze every clause before compiling any body. A present signature must take Atom parameters and
 *  return a numeric type; an untyped constructor function is inferred below. An explicit Atom return makes
 *  its RHS final in the evaluator, so that class stays on the symbolic path. Left-linearity and pairwise
 *  exclusivity cover native and fallback clauses together. */
function scalarCandidate(env: MinEnv, functor: string): ScalarCandidate | undefined {
  if (env.varRulesVar.length !== 0) return undefined;
  const signature = env.sigs.get(functor);
  let declaredArity: number | undefined;
  let declaredReturn: "number" | undefined;
  if (signature !== undefined) {
    if (
      signature.length === 0 ||
      signature.slice(0, -1).some((type) => type.kind !== "sym" || type.name !== "Atom")
    )
      return undefined;
    const returnType = signature[signature.length - 1]!;
    if (returnType.kind !== "sym") return undefined;
    declaredReturn = scalarDeclaredReturn(returnType.name);
    if (declaredReturn === undefined) return undefined;
    declaredArity = signature.length - 1;
  }
  const eqs = env.ruleIndex.get(functor);
  if (eqs === undefined || eqs.length === 0) return undefined;
  let arity: number | undefined;
  const clauses: ScalarClauseCandidate[] = [];
  for (const [lhs, body] of eqs) {
    if (
      lhs.kind !== "expr" ||
      lhs.items.length === 0 ||
      lhs.items[0]!.kind !== "sym" ||
      lhs.items[0]!.name !== functor
    )
      return undefined;
    const clauseArity = lhs.items.length - 1;
    if (declaredArity !== undefined && clauseArity !== declaredArity) return undefined;
    if (arity === undefined) arity = clauseArity;
    else if (clauseArity !== arity) return undefined;
    const slots = new Map<string, number>();
    const pats: SymPat[] = [];
    const positions: ScalarSlotPosition[] = [];
    for (let i = 1; i < lhs.items.length; i++) {
      const pat = compileSymPat(lhs.items[i]!, slots);
      if (pat === undefined) return undefined;
      pats.push(pat);
      collectScalarSlotPositions(pat, i - 1, [], positions);
    }
    clauses.push({
      pats,
      slots,
      positions,
      body,
      mayNeedFreshSuffix: hasVariableOutsideSlots(body, slots),
    });
  }
  if (arity === undefined) return undefined;
  for (let i = 0; i < clauses.length; i++)
    for (let j = i + 1; j < clauses.length; j++)
      if (!scalarClausesDisjoint(clauses[i]!, clauses[j]!)) return undefined;
  return { arity, clauses, declaredReturn };
}

type ScalarReturnHint = "number" | "atom" | "unknown";

function mergeScalarReturnHints(hints: readonly ScalarReturnHint[]): ScalarReturnHint {
  if (hints.includes("atom")) return "atom";
  if (hints.includes("number")) return "number";
  return "unknown";
}

/** Classify only the outer result representation. Unknown LHS slots inherit the numeric family when any
 *  sibling clause proves it, as in `ev`'s `$n` leaf; with no numeric anchor they remain atoms, as in lookup. */
function scalarBodyReturnHint(
  env: MinEnv,
  atom: Atom,
  clause: ScalarClauseCandidate,
  scalarReturns: ReadonlyMap<string, "number" | "atom">,
  functional: FunctionalFns,
  scalarNames: ReadonlySet<string>,
): ScalarReturnHint {
  if (atom.kind === "var") return clause.slots.has(atom.name) ? "unknown" : "atom";
  if (atom.kind === "gnd")
    return atom.value.g === "int" || atom.value.g === "float" ? "number" : "atom";
  if (atom.kind === "sym") return "atom";
  if (atom.items.length === 0) return "atom";
  const head = atom.items[0]!;
  if (head.kind === "var" && atom.items.length === 3) {
    const slot = clause.slots.get(head.name);
    if (slot !== undefined && clause.positions[slot]?.path.length !== 0) return "number";
  }
  if (head.kind !== "sym") return "atom";
  const op = head.name;
  if (op === "+" || op === "-" || op === "*" || op === "/" || op === "%") return "number";
  if (op === "if" && atom.items.length === 4)
    return mergeScalarReturnHints([
      scalarBodyReturnHint(env, atom.items[2]!, clause, scalarReturns, functional, scalarNames),
      scalarBodyReturnHint(env, atom.items[3]!, clause, scalarReturns, functional, scalarNames),
    ]);
  if (op === "unify" && atom.items.length === 5)
    return mergeScalarReturnHints([
      scalarBodyReturnHint(env, atom.items[3]!, clause, scalarReturns, functional, scalarNames),
      scalarBodyReturnHint(env, atom.items[4]!, clause, scalarReturns, functional, scalarNames),
    ]);
  if (op === "let" && atom.items.length === 4)
    return scalarBodyReturnHint(
      env,
      atom.items[3]!,
      clause,
      scalarReturns,
      functional,
      scalarNames,
    );
  if (scalarNames.has(op)) return scalarReturns.get(op) ?? "unknown";
  const functionalReturn = functional.get(op)?.retType;
  if (functionalReturn !== undefined) return isNumberType(functionalReturn) ? "number" : "atom";
  if (KNOWN_OPS.has(op) || env.ruleIndex.has(op) || env.gt.has(op) || env.agt.has(op))
    return "unknown";
  return "atom";
}

function inferScalarReturns(
  env: MinEnv,
  candidates: ReadonlyMap<string, ScalarCandidate>,
  functional: FunctionalFns,
): Map<string, "number" | "atom"> {
  const returns = new Map<string, "number" | "atom">();
  for (const [functor, candidate] of candidates)
    if (candidate.declaredReturn !== undefined) returns.set(functor, candidate.declaredReturn);
  const scalarNames = new Set(candidates.keys());
  const propagate = (): void => {
    for (let changed = true; changed; ) {
      changed = false;
      for (const [functor, candidate] of candidates) {
        if (candidate.declaredReturn !== undefined) continue;
        const hint = mergeScalarReturnHints(
          candidate.clauses.map((clause) =>
            scalarBodyReturnHint(env, clause.body, clause, returns, functional, scalarNames),
          ),
        );
        const previous = returns.get(functor);
        const next =
          previous === "atom" || hint === "atom"
            ? "atom"
            : previous === "number" || hint === "number"
              ? "number"
              : undefined;
        if (next !== undefined && next !== previous) {
          returns.set(functor, next);
          changed = true;
        }
      }
    }
  };
  propagate();
  // A direct slot/call-only function has no numeric evidence. Keeping its values as atoms is the
  // representation-preserving choice. Propagate these final atom seeds back through callers so the result
  // does not depend on candidate iteration order. The productivity pass still removes a cycle with no base.
  for (const functor of candidates.keys()) if (!returns.has(functor)) returns.set(functor, "atom");
  propagate();
  return returns;
}

function hasScalarCallUnderConstructor(
  env: MinEnv,
  atom: Atom,
  scalarNames: ReadonlySet<string>,
  functional: FunctionalFns,
  underConstructor = false,
): boolean {
  if (atom.kind !== "expr" || atom.items.length === 0) return false;
  const head = atom.items[0]!;
  const op = head.kind === "sym" ? head.name : undefined;
  if (underConstructor && op !== undefined && scalarNames.has(op)) return true;
  const isConstructor =
    op === undefined ||
    (!KNOWN_OPS.has(op) &&
      !scalarNames.has(op) &&
      !functional.has(op) &&
      !env.ruleIndex.has(op) &&
      !env.gt.has(op) &&
      !env.agt.has(op));
  return atom.items.some((item) =>
    hasScalarCallUnderConstructor(
      env,
      item,
      scalarNames,
      functional,
      underConstructor || isConstructor,
    ),
  );
}

function hasScalarCall(atom: Atom, scalarNames: ReadonlySet<string>): boolean {
  if (atom.kind !== "expr" || atom.items.length === 0) return false;
  const head = atom.items[0]!;
  if (head.kind === "sym" && scalarNames.has(head.name)) return true;
  return atom.items.some((item) => hasScalarCall(item, scalarNames));
}

function isSingleGuardedScalarCandidate(
  candidate: ScalarCandidate,
  scalarNames: ReadonlySet<string>,
): boolean {
  if (candidate.clauses.length !== 1) return false;
  const body = candidate.clauses[0]!.body;
  return (
    body.kind === "expr" &&
    body.items.length === 4 &&
    body.items[0]!.kind === "sym" &&
    body.items[0]!.name === "if" &&
    hasScalarCall(body, scalarNames)
  );
}

/** Keep established one-step symbolic rewrites on their existing holder. Untyped scalar dispatch is useful
 *  when clauses mix value and atom representations, or when a constructor contains a call that the scalar
 *  path can execute while building the result. A single guarded clause joins the same path when its guard
 *  or branches call another scalar candidate. An explicit supported return type requests scalar semantics. */
function scalarCandidateAddsNativeWork(
  env: MinEnv,
  candidate: ScalarCandidate,
  returnType: "number" | "atom",
  returns: ReadonlyMap<string, "number" | "atom">,
  candidates: ReadonlyMap<string, ScalarCandidate>,
  functional: FunctionalFns,
): boolean {
  if (candidate.declaredReturn !== undefined) return true;
  if (returnType === "number") return true;
  const scalarNames = new Set(candidates.keys());
  const hints = candidate.clauses.map((clause) =>
    scalarBodyReturnHint(env, clause.body, clause, returns, functional, scalarNames),
  );
  if (hints.includes("number") && hints.includes("atom")) return true;
  if (
    candidate.clauses.some(
      (clause) => clause.body.kind === "var" && clause.slots.has(clause.body.name),
    )
  )
    return true;
  if (isSingleGuardedScalarCandidate(candidate, scalarNames)) return true;
  return candidate.clauses.some((clause) =>
    hasScalarCallUnderConstructor(env, clause.body, scalarNames, functional),
  );
}

function scalarSlot(frame: FrameVal[], position: ScalarSlotPosition): Atom {
  let value = frame[position.arg];
  if (!isAtomFrameVal(value)) throw BAIL;
  for (const index of position.path) {
    if (value.kind !== "expr") throw BAIL;
    value = value.items[index];
    if (value === undefined) throw BAIL;
  }
  return value;
}

function scalarScope(clause: ScalarClauseCandidate, arity: number): Scope {
  const vars = new Map<string, ScopedValue>();
  for (const [name, slot] of clause.slots) {
    const position = clause.positions[slot]!;
    vars.set(name, {
      acc: (frame) => scalarSlot(frame, position),
      type: "atom",
      runtimeNumericHead: position.path.length !== 0,
    });
  }
  return { vars, len: arity };
}

/** Build an atom result while executing supported nested value calls. Unresolved heads are constructors;
 *  a known operation or rule that cannot compile declines the clause instead of surviving as a thunk. */
function compileScalarAtom(
  env: MinEnv,
  atom: Atom,
  scope: Scope,
  holders: ValueFns,
): Compiled | undefined {
  if (atom.kind === "var") {
    const bound = scope.vars.get(atom.name);
    if (bound !== undefined) return coerceForReturn({ node: bound.acc, type: bound.type }, "atom");
    const name = atom.name;
    return {
      node: (_frame, runtime) => {
        if (runtime.freshSuffix.length === 0) throw BAIL;
        return variable(name + runtime.freshSuffix);
      },
      type: "atom",
    };
  }
  if (atom.kind !== "expr") return { node: () => atom, type: "atom" };

  const value = coerceForReturn(compileBody(atom, scope, holders), "atom");
  if (value !== undefined) return value;
  if (atom.items.length === 0) return { node: () => atom, type: "atom" };
  const head = atom.items[0]!;
  const op = head.kind === "sym" ? head.name : undefined;

  if (op === "if" && atom.items.length === 4) {
    const condition = compileBody(atom.items[1]!, scope, holders);
    const thenBranch = compileScalarAtom(env, atom.items[2]!, scope, holders);
    const elseBranch = compileScalarAtom(env, atom.items[3]!, scope, holders);
    if (
      condition === undefined ||
      condition.type !== "bool" ||
      thenBranch === undefined ||
      elseBranch === undefined
    )
      return undefined;
    const conditionNode = condition.node as (
      frame: FrameVal[],
      runtime: FunctionalRuntime,
    ) => boolean;
    return {
      node: (frame, runtime) => {
        const selected = conditionNode(frame, runtime);
        runtime.counterDelta += 2;
        return (selected ? thenBranch : elseBranch).node(frame, runtime);
      },
      type: "atom",
    };
  }

  if (op === "let" && atom.items.length === 4 && atom.items[1]!.kind === "var") {
    const boundValue =
      compileBody(atom.items[2]!, scope, holders) ??
      compileScalarAtom(env, atom.items[2]!, scope, holders);
    if (boundValue === undefined) return undefined;
    const index = scope.len;
    const nextScope: Scope = {
      vars: new Map(scope.vars).set(atom.items[1]!.name, {
        acc: (frame) => frame[index]!,
        type: boundValue.type,
      }),
      len: index + 1,
    };
    const body = compileScalarAtom(env, atom.items[3]!, nextScope, holders);
    if (body === undefined) return undefined;
    return {
      node: (frame, runtime) => {
        const next = [...frame, boundValue.node(frame, runtime) as FrameVal];
        runtime.counterDelta += 1;
        return body.node(next, runtime);
      },
      type: "atom",
    };
  }

  if (
    op !== undefined &&
    (KNOWN_OPS.has(op) ||
      holders.has(op) ||
      env.ruleIndex.has(op) ||
      env.gt.has(op) ||
      env.agt.has(op))
  )
    return undefined;

  const items = atom.items.map((item) => compileScalarAtom(env, item, scope, holders));
  if (items.some((item) => item === undefined)) return undefined;
  const nodes = items.map((item) => item!.node);
  return {
    node: (frame, runtime) => expr(nodes.map((node) => frameValueToAtom(node(frame, runtime)))),
    type: "atom",
  };
}

/** Keep exact scalar self-calls in tail position while allowing atom-valued base branches. A tail call that
 *  cannot produce a complete next frame declines the clause instead of silently becoming ordinary
 *  recursion. Calls nested inside another value stay on compileScalarAtom's depth-tracked path. */
function compileScalarTail(
  env: MinEnv,
  atom: Atom,
  scope: Scope,
  holders: ValueFns,
  self: string,
  expected: "number" | "atom",
): Compiled | undefined {
  if (atom.kind === "expr" && atom.items.length > 0 && atom.items[0]!.kind === "sym") {
    const op = atom.items[0]!.name;
    if (op === "if" && atom.items.length === 4)
      return compileIf(atom.items[1]!, atom.items[2]!, atom.items[3]!, scope, holders, (branch) =>
        compileScalarTail(env, branch, scope, holders, self, expected),
      );
    if (op === self) return compileTailSelfCall(atom, scope, holders, self);
  }
  return expected === "number"
    ? coerceForReturn(compileBody(atom, scope, holders), expected)
    : compileScalarAtom(env, atom, scope, holders);
}

function compileScalarClause(
  env: MinEnv,
  functor: string,
  candidate: ScalarCandidate,
  clause: ScalarClauseCandidate,
  expected: "number" | "atom",
  holders: ValueFns,
): Compiled | undefined {
  const scope = scalarScope(clause, candidate.arity);
  return compileScalarTail(env, clause.body, scope, holders, functor, expected);
}

function scalarDependencies(
  atom: Atom,
  scalarNames: ReadonlySet<string>,
  dependencies: Set<string>,
): void {
  if (atom.kind !== "expr" || atom.items.length === 0) return;
  const head = atom.items[0]!;
  if (head.kind === "sym" && scalarNames.has(head.name)) dependencies.add(head.name);
  for (const item of atom.items) scalarDependencies(item, scalarNames, dependencies);
}

/** Whether one evaluated control-flow path avoids a direct call to `self`. The productivity fixpoint can
 *  then use the clause's native base path instead of treating a conditional self-call as unconditional. */
function hasScalarPathWithoutSelfCall(atom: Atom, self: string): boolean {
  if (atom.kind !== "expr" || atom.items.length === 0) return true;
  const head = atom.items[0]!;
  if (head.kind === "sym" && head.name === self) return false;
  if (head.kind === "sym" && head.name === "if" && atom.items.length === 4)
    return (
      hasScalarPathWithoutSelfCall(atom.items[1]!, self) &&
      (hasScalarPathWithoutSelfCall(atom.items[2]!, self) ||
        hasScalarPathWithoutSelfCall(atom.items[3]!, self))
    );
  return atom.items.every((item) => hasScalarPathWithoutSelfCall(item, self));
}

/** Compile each proven-exclusive clause independently. Unsupported bodies stay in the matcher with no node;
 *  selecting one throws BAIL and replays the root call through the evaluator. */
function compileScalarHolders(
  env: MinEnv,
  pure: ReadonlySet<string>,
  functional: FunctionalFns,
): Map<string, ScalarHolder> {
  const candidates = new Map<string, ScalarCandidate>();
  for (const functor of pure) {
    if (functional.has(functor)) continue;
    const candidate = scalarCandidate(env, functor);
    if (candidate !== undefined) candidates.set(functor, candidate);
  }
  const scalarReturns = inferScalarReturns(env, candidates, functional);

  const holders = new Map<string, ScalarHolder>();
  const values = new Map<string, ValueHolder>(functional);
  for (const [functor, candidate] of candidates) {
    const retType = scalarReturns.get(functor)!;
    if (
      !scalarCandidateAddsNativeWork(env, candidate, retType, scalarReturns, candidates, functional)
    )
      continue;
    const holder: ScalarHolder = {
      kind: "scalar",
      name: functor,
      arity: candidate.arity,
      retType,
      paramTypes: new Array<Ty>(candidate.arity).fill("atom"),
      clauseCount: candidate.clauses.length,
      run: bailRun,
    };
    holders.set(functor, holder);
    values.set(functor, holder);
  }

  for (;;) {
    let removed = false;
    const plans = new Map<string, Array<Node | undefined>>();
    const dependencies = new Map<string, Array<ReadonlySet<string>>>();
    const scalarNames = new Set(holders.keys());
    for (const [functor] of holders) {
      const candidate = candidates.get(functor)!;
      const expected = holders.get(functor)!.retType;
      const nodes = candidate.clauses.map((clause) => {
        const compiled = compileScalarClause(env, functor, candidate, clause, expected, values);
        return compiled?.type === expected ? compiled.node : undefined;
      });
      dependencies.set(
        functor,
        candidate.clauses.map((clause) => {
          const callees = new Set<string>();
          scalarDependencies(clause.body, scalarNames, callees);
          if (hasScalarPathWithoutSelfCall(clause.body, functor)) callees.delete(functor);
          return callees;
        }),
      );
      if (nodes.every((node) => node === undefined)) {
        holders.delete(functor);
        values.delete(functor);
        removed = true;
      } else plans.set(functor, nodes);
    }
    if (removed) continue;

    // A recursive-only numeric fragment such as Greater's `(Greater (S $x) (S $y))` branch can compile
    // syntactically but can never produce a native int when its True/False base clauses are fallbacks.
    // Seed holders with a compiled clause that has no scalar dependencies, then propagate through
    // productive sibling/self calls. A holder outside the fixpoint has no successful native return path,
    // so leave the whole functor to the symbolic compiler.
    const productive = new Set<string>();
    for (let changed = true; changed; ) {
      changed = false;
      for (const [functor, nodes] of plans) {
        if (productive.has(functor)) continue;
        const clauseDependencies = dependencies.get(functor)!;
        if (
          nodes.some(
            (node, i) =>
              node !== undefined &&
              [...clauseDependencies[i]!].every((callee) => productive.has(callee)),
          )
        ) {
          productive.add(functor);
          changed = true;
        }
      }
    }
    for (const functor of [...holders.keys()])
      if (!productive.has(functor)) {
        holders.delete(functor);
        values.delete(functor);
        removed = true;
      }
    if (removed) continue;

    for (const [functor, holder] of holders) {
      const candidate = candidates.get(functor)!;
      const nodes = plans.get(functor)!;
      const dispatch: Node = (frame, runtime) => {
        for (let i = 0; i < candidate.arity; i++) {
          const arg = frame[i];
          if (!isAtomFrameVal(arg) || !arg.ground) throw BAIL;
        }
        const counterStart = runtime.counterDelta - 1;
        runtime.counterDelta += candidate.clauses.length - 1;
        for (let i = 0; i < candidate.clauses.length; i++) {
          const clause = candidate.clauses[i]!;
          let matches = true;
          for (let j = 0; j < candidate.arity; j++)
            if (!matchSymPat(clause.pats[j]!, frame[j] as Atom)) {
              matches = false;
              break;
            }
          if (!matches) continue;
          const node = nodes[i];
          if (node === undefined) throw BAIL;
          if (!clause.mayNeedFreshSuffix) return node(frame, runtime);
          const previousSuffix = runtime.freshSuffix;
          runtime.freshSuffix = "#" + (runtime.counterBase + counterStart + i);
          try {
            return node(frame, runtime);
          } finally {
            runtime.freshSuffix = previousSuffix;
          }
        }
        throw BAIL;
      };
      // Scalar frames are small enough to reach the language bound directly. The explicit logical
      // depth check cuts first; a larger bound may still fall back on a native RangeError.
      holder.run = makeRun(functor, candidate.arity, dispatch, false, 0);
    }
    return holders;
  }
}

// ---------- guarded recursive constructor choice unions ----------

type ChoiceUnionClause =
  | { readonly tag: "seed"; readonly values: readonly Atom[] }
  | {
      readonly tag: "recursive";
      readonly constructor: SymAtom;
      readonly operators: readonly SymAtom[];
    };

const CHOICE_UNION_NUMERIC_OPS = new Set(["+", "-", "*"]);

function choiceUnionConstructor(env: MinEnv, name: string): boolean {
  return !env.ruleIndex.has(name) && !env.gt.has(name) && !env.agt.has(name) && !env.sigs.has(name);
}

function signaturePrefix(
  env: MinEnv,
  name: string,
  expected: readonly string[],
  length = expected.length,
): boolean {
  const actual = env.sigs.get(name);
  return (
    actual !== undefined &&
    actual.length === length &&
    expected.every(
      (typeName, index) => actual[index]!.kind === "sym" && actual[index]!.name === typeName,
    )
  );
}

function choiceUnionBuiltinsUnchanged(env: MinEnv): boolean {
  if ((env.ruleIndex.get("if")?.length ?? 0) !== 2) return false;
  for (const name of ["superpose", "empty", ...CHOICE_UNION_NUMERIC_OPS, ">"])
    if ((env.ruleIndex.get(name)?.length ?? 0) !== 0 || !env.gt.has(name) || env.agt.has(name))
      return false;
  return (
    signaturePrefix(env, "if", ["Bool", "Atom", "Atom"], 4) &&
    signaturePrefix(env, "superpose", ["Expression", "%Undefined%"]) &&
    signaturePrefix(env, "+", ["Number", "Number", "Number"]) &&
    signaturePrefix(env, "-", ["Number", "Number", "Number"]) &&
    signaturePrefix(env, "*", ["Number", "Number", "Number"]) &&
    signaturePrefix(env, ">", ["Number", "Number", "Bool"])
  );
}

function choiceUnionStaticData(env: MinEnv, atom: Atom): boolean {
  if (atom.kind === "var") return false;
  if (atom.kind !== "expr" || atom.items.length === 0) return true;
  const head = atom.items[0]!;
  return (
    head.kind === "sym" &&
    choiceUnionConstructor(env, head.name) &&
    atom.items.slice(1).every((item) => choiceUnionStaticData(env, item))
  );
}

function choiceUnionSeed(env: MinEnv, rhs: Atom): ChoiceUnionClause | undefined {
  if (
    rhs.kind !== "expr" ||
    rhs.items.length !== 2 ||
    rhs.items[0]!.kind !== "sym" ||
    rhs.items[0]!.name !== "superpose"
  )
    return undefined;
  const source = rhs.items[1]!;
  if (
    source.kind !== "expr" ||
    source.items.length === 0 ||
    !source.ground ||
    !choiceUnionStaticData(env, source)
  )
    return undefined;
  return { tag: "seed", values: source.items };
}

function choiceUnionRecursiveCall(atom: Atom, functor: string, parameter: string): boolean {
  if (
    atom.kind !== "expr" ||
    atom.items.length !== 2 ||
    atom.items[0]!.kind !== "sym" ||
    atom.items[0]!.name !== functor
  )
    return false;
  const decrement = atom.items[1]!;
  return (
    decrement.kind === "expr" &&
    decrement.items.length === 3 &&
    decrement.items[0]!.kind === "sym" &&
    decrement.items[0]!.name === "-" &&
    decrement.items[1]!.kind === "var" &&
    decrement.items[1]!.name === parameter &&
    decrement.items[2]!.kind === "gnd" &&
    decrement.items[2]!.value.g === "int" &&
    cmpIntVal(decrement.items[2]!.value.n, 1) === 0
  );
}

function choiceUnionRecursiveClause(
  env: MinEnv,
  rhs: Atom,
  functor: string,
  parameter: string,
): ChoiceUnionClause | undefined {
  if (
    rhs.kind !== "expr" ||
    rhs.items.length !== 4 ||
    rhs.items[0]!.kind !== "sym" ||
    rhs.items[0]!.name !== "if" ||
    !isEmptyCall(rhs.items[3]!)
  )
    return undefined;
  const condition = rhs.items[1]!;
  if (
    condition.kind !== "expr" ||
    condition.items.length !== 3 ||
    condition.items[0]!.kind !== "sym" ||
    condition.items[0]!.name !== ">" ||
    condition.items[1]!.kind !== "var" ||
    condition.items[1]!.name !== parameter ||
    condition.items[2]!.kind !== "gnd" ||
    condition.items[2]!.value.g !== "int" ||
    cmpIntVal(condition.items[2]!.value.n, 0) !== 0
  )
    return undefined;
  const product = rhs.items[2]!;
  if (
    product.kind !== "expr" ||
    product.items.length !== 4 ||
    product.items[0]!.kind !== "sym" ||
    !choiceUnionConstructor(env, product.items[0]!.name)
  )
    return undefined;
  const superpose = product.items[1]!;
  if (
    superpose.kind !== "expr" ||
    superpose.items.length !== 2 ||
    superpose.items[0]!.kind !== "sym" ||
    superpose.items[0]!.name !== "superpose"
  )
    return undefined;
  const operatorTuple = superpose.items[1]!;
  if (
    operatorTuple.kind !== "expr" ||
    operatorTuple.items.length === 0 ||
    !operatorTuple.items.every(
      (item): item is SymAtom => item.kind === "sym" && CHOICE_UNION_NUMERIC_OPS.has(item.name),
    ) ||
    !choiceUnionRecursiveCall(product.items[2]!, functor, parameter) ||
    !choiceUnionRecursiveCall(product.items[3]!, functor, parameter)
  )
    return undefined;
  return {
    tag: "recursive",
    constructor: product.items[0]!,
    operators: operatorTuple.items,
  };
}

function choiceUnionParameter(lhs: Atom, functor: string): string | undefined {
  if (
    lhs.kind !== "expr" ||
    lhs.items.length !== 2 ||
    lhs.items[0]!.kind !== "sym" ||
    lhs.items[0]!.name !== functor ||
    lhs.items[1]!.kind !== "var"
  )
    return undefined;
  return lhs.items[1]!.name;
}

/** Compile only the synthesis-style union: one finite `superpose` seed and one `if`-guarded constructor
 *  product with two identical `(- $depth 1)` recursive calls. Both heads are catch-all variables, so every
 *  call runs both clauses in source order. Other nondeterministic rule shapes stay on the general compiler. */
function compileChoiceUnion(env: MinEnv, functor: string): NondetHolder | undefined {
  const equations = env.ruleIndex.get(functor);
  if (env.varRulesVar.length !== 0 || equations?.length !== 2 || !choiceUnionBuiltinsUnchanged(env))
    return undefined;

  const clauses: ChoiceUnionClause[] = [];
  let seeds = 0;
  let recursive = 0;
  for (const [lhs, rhs] of equations) {
    const parameter = choiceUnionParameter(lhs, functor);
    if (parameter === undefined) return undefined;
    const clause =
      choiceUnionSeed(env, rhs) ?? choiceUnionRecursiveClause(env, rhs, functor, parameter);
    if (clause === undefined) return undefined;
    if (clause.tag === "seed") seeds++;
    else recursive++;
    clauses.push(clause);
  }
  if (seeds !== 1 || recursive !== 1) return undefined;

  return {
    kind: "nondet",
    arity: 1,
    clauseCount: clauses.length,
    preferDirectForModed: false,
    run: (_env, partAtoms, st, ops, fuel) => {
      if (st.world.selfRules.size !== 0 || st.world.removedStatic !== null) return undefined;
      const depthAtom = partAtoms[0];
      if (partAtoms.length !== 1 || depthAtom?.kind !== "gnd" || depthAtom.value.g !== "int")
        return undefined;
      const results: CompiledAtomResult[] = [];
      const evaluationDepth = ops.evaluationDepth;
      const depthLimit = ops.maxStackDepth ?? 0;
      const cap = fuel === undefined || fuel < NONDET_CALL_CAP ? NONDET_CALL_CAP : fuel;
      let dispatches = 0;
      let counterDelta = 0;

      const dispatch = (
        depthValue: IntVal,
        emit: (value: Atom) => void,
        enterDepth: boolean,
      ): void => {
        if (++dispatches > cap) throw BAIL;
        let entered = false;
        if (enterDepth && evaluationDepth !== undefined) {
          const boundary = evaluationDepth.enterBoundary(depthLimit, EVALUATION_TRAMPOLINE_DEPTH);
          if (boundary !== undefined)
            throwEvaluationDepthBoundary(boundary, expr([sym(functor), gint(depthValue)]), {
              counter: st.counter + counterDelta,
              world: st.world,
            });
          entered = true;
        }
        try {
          counterDelta += clauses.length;
          for (const clause of clauses) {
            if (clause.tag === "seed") {
              for (const value of clause.values) emit(value);
              continue;
            }
            // The standard `if` scans both clauses before selecting its deterministic branch.
            counterDelta += 2;
            if (cmpIntVal(depthValue, 0) <= 0) continue;
            const nextDepth = subInt(depthValue, 1);
            for (const operator of clause.operators)
              dispatch(
                nextDepth,
                (left) =>
                  dispatch(
                    nextDepth,
                    (right) => emit(expr([clause.constructor, operator, left, right])),
                    true,
                  ),
                true,
              );
          }
        } finally {
          if (entered) evaluationDepth?.leave();
        }
      };

      try {
        dispatch(depthAtom.value.n, (atom) => results.push({ atom, bnd: emptyBindings }), false);
        return { results, counterDelta, resultsFinal: true };
      } catch (error) {
        if (error === BAIL || error instanceof RangeError) return undefined;
        throw error;
      }
    },
  };
}

// ---------- synthesis choice-filter-render pipelines ----------

type QuotedRendererBody =
  | { readonly tag: "quote"; readonly template: SymTpl }
  | {
      readonly tag: "recursive";
      readonly calls: ReadonlyArray<{ readonly sourceSlot: number; readonly resultSlot: number }>;
      readonly template: SymTpl;
      readonly slotCount: number;
    };

interface QuotedRendererClause {
  readonly pat: SymPat;
  readonly body: QuotedRendererBody;
}

interface QuotedRenderer {
  readonly run: (
    atom: Atom,
    runtime: FunctionalRuntime,
    world: St["world"],
    entered?: boolean,
  ) => Atom;
}

function standardQuoteUnchanged(env: MinEnv): boolean {
  const rules = env.ruleIndex.get("quote");
  if (rules?.length !== 1 || !signaturePrefix(env, "quote", ["Atom", "Atom"])) return false;
  const [lhs, rhs] = rules[0]!;
  return (
    lhs.kind === "expr" &&
    lhs.items.length === 2 &&
    lhs.items[0]!.kind === "sym" &&
    lhs.items[0]!.name === "quote" &&
    lhs.items[1]!.kind === "var" &&
    rhs.kind === "sym" &&
    rhs.name === "NotReducible"
  );
}

function quotedBody(atom: Atom): Atom | undefined {
  return atom.kind === "expr" &&
    atom.items.length === 2 &&
    atom.items[0]!.kind === "sym" &&
    atom.items[0]!.name === "quote"
    ? atom.items[1]!
    : undefined;
}

function compileQuotedRendererClause(
  env: MinEnv,
  functor: string,
  lhs: Atom,
  rhs: Atom,
): QuotedRendererClause | undefined {
  if (
    lhs.kind !== "expr" ||
    lhs.items.length !== 2 ||
    lhs.items[0]!.kind !== "sym" ||
    lhs.items[0]!.name !== functor
  )
    return undefined;
  const slots = new Map<string, number>();
  const pat = compileSymPat(lhs.items[1]!, slots);
  if (pat === undefined) return undefined;
  const direct = quotedBody(rhs);
  if (direct !== undefined) {
    if (hasVariableOutsideSlots(direct, slots)) return undefined;
    return { pat, body: { tag: "quote", template: compileSymTpl(direct, slots) } };
  }
  if (
    rhs.kind !== "expr" ||
    rhs.items.length !== 3 ||
    rhs.items[0]!.kind !== "sym" ||
    rhs.items[0]!.name !== "let*" ||
    rhs.items[1]!.kind !== "expr"
  )
    return undefined;

  const calls: Array<{ readonly sourceSlot: number; readonly resultSlot: number }> = [];
  for (const pair of rhs.items[1]!.items) {
    if (
      pair.kind !== "expr" ||
      pair.items.length !== 2 ||
      pair.items[0]!.kind !== "expr" ||
      pair.items[0]!.items.length !== 2 ||
      pair.items[0]!.items[0]!.kind !== "sym" ||
      pair.items[0]!.items[0]!.name !== "quote" ||
      pair.items[0]!.items[1]!.kind !== "var" ||
      pair.items[1]!.kind !== "expr" ||
      pair.items[1]!.items.length !== 2 ||
      pair.items[1]!.items[0]!.kind !== "sym" ||
      pair.items[1]!.items[0]!.name !== functor ||
      pair.items[1]!.items[1]!.kind !== "var"
    )
      return undefined;
    const resultName = pair.items[0]!.items[1]!.name;
    const sourceName = pair.items[1]!.items[1]!.name;
    const sourceSlot = slots.get(sourceName);
    if (sourceSlot === undefined || slots.has(resultName)) return undefined;
    const resultSlot = slots.size;
    slots.set(resultName, resultSlot);
    calls.push({ sourceSlot, resultSlot });
  }
  if (calls.length === 0) return undefined;
  const template = quotedBody(rhs.items[2]!);
  if (template === undefined || hasVariableOutsideSlots(template, slots)) return undefined;
  if (
    (env.ruleIndex.get("let*")?.length ?? 0) !== 1 ||
    (env.ruleIndex.get("let")?.length ?? 0) !== 1
  )
    return undefined;
  return {
    pat,
    body: {
      tag: "recursive",
      calls,
      template: compileSymTpl(template, slots),
      slotCount: slots.size,
    },
  };
}

function compileQuotedRenderer(env: MinEnv, functor: string): QuotedRenderer | undefined {
  if (env.sigs.has(functor) || !standardQuoteUnchanged(env)) return undefined;
  const equations = env.ruleIndex.get(functor);
  if (equations === undefined || equations.length === 0) return undefined;
  const clauses: QuotedRendererClause[] = [];
  for (const [lhs, rhs] of equations) {
    const clause = compileQuotedRendererClause(env, functor, lhs, rhs);
    if (clause === undefined) return undefined;
    clauses.push(clause);
  }
  for (let i = 0; i < clauses.length; i++)
    for (let j = i + 1; j < clauses.length; j++) {
      const a: ScalarClauseCandidate = {
        pats: [clauses[i]!.pat],
        slots: new Map(),
        positions: [],
        body: emptyExpr,
        mayNeedFreshSuffix: false,
      };
      const b: ScalarClauseCandidate = {
        pats: [clauses[j]!.pat],
        slots: new Map(),
        positions: [],
        body: emptyExpr,
        mayNeedFreshSuffix: false,
      };
      if (!scalarClausesDisjoint(a, b)) return undefined;
    }

  const run = (
    atom: Atom,
    runtime: FunctionalRuntime,
    world: St["world"],
    entered = false,
  ): Atom => {
    if (!entered) {
      const boundary = runtime.depth.enterBoundary(runtime.limit, EVALUATION_TRAMPOLINE_DEPTH);
      if (boundary !== undefined)
        throwEvaluationDepthBoundary(boundary, expr([sym(functor), atom]), {
          counter: runtime.counterBase + runtime.counterDelta,
          world,
        });
    }
    try {
      runtime.counterDelta += clauses.length;
      for (const clause of clauses) {
        const frame: Atom[] = [];
        if (!matchSymPat(clause.pat, atom, frame)) continue;
        if (clause.body.tag === "quote") {
          runtime.counterDelta += 1;
          return expr([sym("quote"), buildSymTpl(clause.body.template, frame, "")]);
        }
        frame.length = clause.body.slotCount;
        for (const call of clause.body.calls) {
          const rendered = run(frame[call.sourceSlot]!, runtime, world);
          if (
            rendered.kind !== "expr" ||
            rendered.items.length !== 2 ||
            rendered.items[0]!.kind !== "sym" ||
            rendered.items[0]!.name !== "quote"
          )
            throw BAIL;
          frame[call.resultSlot] = rendered.items[1]!;
        }
        // Standard let* applies once per list suffix and standard let once per binding.
        runtime.counterDelta += clause.body.calls.length * 2 + 1;
        runtime.counterDelta += 1;
        return expr([sym("quote"), buildSymTpl(clause.body.template, frame, "")]);
      }
      throw BAIL;
    } finally {
      if (!entered) runtime.depth.leave();
    }
  };
  return { run };
}

interface SynthesisPipeline {
  readonly gen: NondetHolder;
  readonly check: ScalarHolder;
  readonly renderer: QuotedRenderer;
  readonly genOp: string;
  readonly checkOp: string;
  readonly renderOp: string;
  readonly start: Atom;
  readonly resultTemplate: SymTpl;
}

function synthesisPipeline(
  env: MinEnv,
  functor: string,
  compiled: CompiledFns,
): SynthesisPipeline | undefined {
  if (
    env.sigs.has(functor) ||
    !standardQuoteUnchanged(env) ||
    (env.ruleIndex.get("if")?.length ?? 0) !== 2 ||
    (env.ruleIndex.get("let")?.length ?? 0) !== 1 ||
    !signaturePrefix(env, "if", ["Bool", "Atom", "Atom"], 4) ||
    !signaturePrefix(env, "let", ["Atom", "%Undefined%", "Atom"], 4) ||
    (env.ruleIndex.get("empty")?.length ?? 0) !== 0 ||
    !env.gt.has("empty") ||
    env.agt.has("empty")
  )
    return undefined;
  const equations = env.ruleIndex.get(functor);
  if (equations?.length !== 1) return undefined;
  const [lhs, rhs] = equations[0]!;
  if (
    lhs.kind !== "expr" ||
    lhs.items.length !== 3 ||
    lhs.items[0]!.kind !== "sym" ||
    lhs.items[0]!.name !== functor ||
    lhs.items[1]!.kind !== "var" ||
    lhs.items[2]!.kind !== "var" ||
    lhs.items[1]!.name === lhs.items[2]!.name ||
    rhs.kind !== "expr" ||
    rhs.items.length !== 4 ||
    rhs.items[0]!.kind !== "sym" ||
    rhs.items[0]!.name !== "let" ||
    rhs.items[1]!.kind !== "var" ||
    rhs.items[2]!.kind !== "expr" ||
    rhs.items[2]!.items.length !== 2 ||
    rhs.items[2]!.items[0]!.kind !== "sym" ||
    rhs.items[2]!.items[1]!.kind !== "var" ||
    rhs.items[2]!.items[1]!.name !== lhs.items[2]!.name ||
    rhs.items[3]!.kind !== "expr" ||
    rhs.items[3]!.items.length !== 4 ||
    rhs.items[3]!.items[0]!.kind !== "sym" ||
    rhs.items[3]!.items[0]!.name !== "if" ||
    !isEmptyCall(rhs.items[3]!.items[3]!)
  )
    return undefined;
  const genOp = rhs.items[2]!.items[0]!.name;
  const choiceVar = rhs.items[1]!.name;
  const condition = rhs.items[3]!.items[1]!;
  const accepted = rhs.items[3]!.items[2]!;
  if (
    condition.kind !== "expr" ||
    condition.items.length !== 4 ||
    condition.items[0]!.kind !== "sym" ||
    condition.items[1]!.kind !== "var" ||
    condition.items[1]!.name !== choiceVar ||
    condition.items[2]!.kind !== "var" ||
    condition.items[2]!.name !== lhs.items[1]!.name ||
    !condition.items[3]!.ground ||
    accepted.kind !== "expr" ||
    accepted.items.length !== 4 ||
    accepted.items[0]!.kind !== "sym" ||
    accepted.items[0]!.name !== "let" ||
    accepted.items[1]!.kind !== "expr" ||
    accepted.items[1]!.items.length !== 2 ||
    accepted.items[1]!.items[0]!.kind !== "sym" ||
    accepted.items[1]!.items[0]!.name !== "quote" ||
    accepted.items[1]!.items[1]!.kind !== "var" ||
    accepted.items[2]!.kind !== "expr" ||
    accepted.items[2]!.items.length !== 2 ||
    accepted.items[2]!.items[0]!.kind !== "sym" ||
    accepted.items[2]!.items[1]!.kind !== "var" ||
    accepted.items[2]!.items[1]!.name !== choiceVar
  )
    return undefined;
  const checkOp = condition.items[0]!.name;
  const renderOp = accepted.items[2]!.items[0]!.name;
  const gen = compiled.get(genOp);
  const check = compiled.get(checkOp);
  const renderer = compileQuotedRenderer(env, renderOp);
  if (
    gen?.kind !== "nondet" ||
    gen.arity !== 1 ||
    check?.kind !== "scalar" ||
    check.arity !== 3 ||
    renderer === undefined
  )
    return undefined;
  const resultBody = quotedBody(accepted.items[3]!);
  if (resultBody === undefined) return undefined;
  const slots = new Map<string, number>([
    [lhs.items[1]!.name, 0],
    [lhs.items[2]!.name, 1],
    [choiceVar, 2],
    [accepted.items[1]!.items[1]!.name, 3],
  ]);
  if (slots.size !== 4 || hasVariableOutsideSlots(resultBody, slots)) return undefined;
  return {
    gen,
    check,
    renderer,
    genOp,
    checkOp,
    renderOp,
    start: condition.items[3]!,
    resultTemplate: compileSymTpl(resultBody, slots),
  };
}

/** Fuse the exact `let candidate <- gen; if check; render` pipeline after all three callees have compiled.
 *  Candidate order remains the generator's order, and a finite work limit declines the atomic run so the
 *  evaluator can cut at the original interpreted step. */
function compileSynthesisPipeline(
  env: MinEnv,
  functor: string,
  compiled: CompiledFns,
): NondetHolder | undefined {
  const pipeline = synthesisPipeline(env, functor, compiled);
  if (pipeline === undefined) return undefined;
  return {
    kind: "nondet",
    arity: 2,
    clauseCount: 1,
    preferDirectForModed: false,
    run: (_env, partAtoms, st, ops, fuel) => {
      if (
        partAtoms.length !== 2 ||
        partAtoms.some((atom) => !atom.ground) ||
        st.world.selfRules.size !== 0 ||
        st.world.removedStatic !== null
      )
        return undefined;
      const runtime: FunctionalRuntime = {
        depth: ops.evaluationDepth ?? new EvaluationDepth(),
        limit: ops.maxStackDepth ?? 0,
        counterBase: st.counter,
        counterLimit:
          st.world.maxSteps > 0 ? st.world.stepStart + st.world.maxSteps - st.counter : undefined,
        counterDelta: 1,
        freshSuffix: "",
      };
      const nested = <T>(op: string, args: readonly Atom[], run: () => T): T => {
        if (ops.evaluationDepth === undefined) return run();
        const boundary = runtime.depth.enterBoundary(runtime.limit, EVALUATION_TRAMPOLINE_DEPTH);
        if (boundary !== undefined)
          throwEvaluationDepthBoundary(boundary, expr([sym(op), ...args]), {
            counter: runtime.counterBase + runtime.counterDelta,
            world: st.world,
          });
        try {
          return run();
        } finally {
          runtime.depth.leave();
        }
      };
      try {
        const generated = nested(pipeline.genOp, [partAtoms[1]!], () =>
          pipeline.gen.run(
            env,
            [partAtoms[1]!],
            {
              counter: runtime.counterBase + runtime.counterDelta,
              world: st.world,
            },
            ops,
            fuel,
          ),
        );
        if (
          generated === undefined ||
          generated.state !== undefined ||
          generated.resultsFinal !== true
        )
          throw BAIL;
        runtime.counterDelta += generated.counterDelta;
        const results: CompiledAtomResult[] = [];
        for (const generatedResult of generated.results) {
          if (generatedResult.bnd.length !== 0) throw BAIL;
          const candidate = generatedResult.atom;
          runtime.counterDelta += 1;
          const checked = nested(pipeline.checkOp, [candidate, partAtoms[0]!, pipeline.start], () =>
            pipeline.check.run([candidate, partAtoms[0]!, pipeline.start], runtime, true),
          );
          const checkedAtom = frameValueToAtom(checked);
          runtime.counterDelta += 2;
          if (checkedAtom.kind !== "gnd" || checkedAtom.value.g !== "bool") throw BAIL;
          if (!checkedAtom.value.b) continue;
          const rendered = nested(pipeline.renderOp, [candidate], () =>
            pipeline.renderer.run(candidate, runtime, st.world, true),
          );
          if (
            rendered.kind !== "expr" ||
            rendered.items.length !== 2 ||
            rendered.items[0]!.kind !== "sym" ||
            rendered.items[0]!.name !== "quote"
          )
            throw BAIL;
          runtime.counterDelta += 1;
          const frame = new Array<Atom>(4);
          frame[0] = partAtoms[0]!;
          frame[1] = partAtoms[1]!;
          frame[2] = candidate;
          frame[3] = rendered.items[1]!;
          runtime.counterDelta += 1;
          results.push({
            atom: expr([sym("quote"), buildSymTpl(pipeline.resultTemplate, frame, "")]),
            bnd: emptyBindings,
          });
        }
        return { results, counterDelta: runtime.counterDelta, resultsFinal: true };
      } catch (error) {
        if (error === BAIL || error instanceof RangeError) return undefined;
        throw error;
      }
    },
  };
}

// ---------- nondeterministic let*-chain rewrites (the backward-chainer class) ----------
//
// PeTTa compiles a multi-equation MeTTa function to Prolog clauses and lets the WAM enumerate:
// clause alternatives are choice points, a `let`/`let*` binding is a unification goal against the
// value's solution stream, and `match` is a goal against a space. This compiles the same fragment to
// a collect-all JS search (clause-major, depth-first: success pushes and continues, failure falls
// through), replacing the interpreter's per-step machinery (atomToStack/interpretLoopG frames,
// per-reduction type checks, queryVarsOf, whole-body instantiate) while reusing its meaning-bearing
// primitives unchanged: matchAtomsScoped for the freshened head unification (which also binds a
// caller's free variable to the clause's freshened skeleton), instantiate for goal arguments and
// templates, matchAtoms/merge/hasLoop for destructuring solutions, and the injected matchSolutions
// (the interpreter's own match plan) for space goals. Fresh-variable NAMES can differ from the
// interpreted path (one monotonic counter threads the search instead of the stack machine's
// interleaving); that is the impure-VM precedent: results stay deterministic and alpha-equivalent,
// the equality the oracle and LeaTTa check.

// Past this hedge, a compiled search continues only while active recursive calls carry a dynamic
// well-foundedness certificate. Finite sibling breadth may exceed the hedge; an unproven recurrence
// bails to the interpreter, whose fuel budget governs it.
const NONDET_CALL_CAP = 4_000_000;

interface AtomRecurrenceFrame {
  readonly fn: string;
  readonly positions: readonly number[];
  readonly values: readonly IntVal[];
}

const naturalAtomInt = (atom: Atom | undefined): IntVal | undefined =>
  atom?.kind === "gnd" && atom.value.g === "int" && cmpIntVal(atom.value.n, 0) >= 0
    ? atom.value.n
    : undefined;

function enterAtomNaturalRecurrence(
  active: AtomRecurrenceFrame[],
  fn: string,
  args: readonly Atom[],
): AtomRecurrenceFrame | undefined {
  let previous: AtomRecurrenceFrame | undefined;
  for (let i = active.length - 1; i >= 0; i--)
    if (active[i]!.fn === fn) {
      previous = active[i];
      break;
    }

  if (previous === undefined) {
    const positions: number[] = [];
    const values: IntVal[] = [];
    for (let i = 0; i < args.length; i++) {
      const value = naturalAtomInt(args[i]);
      if (value !== undefined) {
        positions.push(i);
        values.push(value);
      }
    }
    const frame = { fn, positions, values };
    active.push(frame);
    return frame;
  }

  if (previous.positions.length === 0) return undefined;
  const values: IntVal[] = [];
  let order = 0;
  for (let i = 0; i < previous.positions.length; i++) {
    const value = naturalAtomInt(args[previous.positions[i]!]);
    if (value === undefined) return undefined;
    values.push(value);
    if (order === 0) order = cmpIntVal(value, previous.values[i]!);
  }
  if (order >= 0) return undefined;
  const frame = { fn, positions: previous.positions, values };
  active.push(frame);
  return frame;
}

type NondetCall =
  | { readonly tag: "call"; readonly fn: string; readonly args: readonly Atom[] }
  | {
      readonly tag: "match";
      readonly space: Atom;
      readonly pattern: Atom;
      readonly template: Atom;
    };

interface NondetGoal {
  readonly pat: Atom;
  readonly call: NondetCall;
}

// A terminal: a template to emit, `empty` (an `(if ...)` branch that yields no solutions), or a tail call.
type NondetTail =
  | { readonly tag: "tpl"; readonly atom: Atom }
  | { readonly tag: "empty" }
  | NondetCall;

// A clause body, compiled to a tree so a size/depth guard `(if (< k $s) <search> (empty))` selects a
// sub-body at runtime. A `seq` is a let*/let goal chain ending in a tail; an `if` picks a branch by a
// ground comparison guard evaluated over the bound arguments.
type NondetBody =
  | { readonly tag: "seq"; readonly goals: readonly NondetGoal[]; readonly tail: NondetTail }
  | {
      readonly tag: "if";
      readonly cond: Atom;
      readonly then: NondetBody;
      readonly els: NondetBody;
    };

interface NondetClause {
  readonly lhs: Atom;
  readonly body: NondetBody;
}

/** Data under evaluation: contains no rule-defined or grounded-op head anywhere, so the type-directed
 *  argument evaluation would return it unchanged (constructors, vars, and ground leaves only). */
function nondetIsData(env: MinEnv, a: Atom): boolean {
  if (a.kind !== "expr" || a.items.length === 0) return true;
  const h = a.items[0]!;
  if (h.kind === "expr" && h.items.length > 0) return false;
  if (
    h.kind === "sym" &&
    (env.ruleIndex.has(h.name) || env.gt.has(h.name) || IMPURE_OPS.has(h.name))
  )
    return false;
  return a.items.every((x) => nondetIsData(env, x));
}

// Binary integer operators the search folds once both operands bind to concrete ints, and the
// comparison operators an `(if ...)` guard may test. Both evaluate at runtime through the interpreter's
// own grounded ops (callGrounded), so the compiled result is byte-identical to the interpreted one.
const ARITH_FOLD = new Set(["+", "-", "*"]);
const NONDET_COMPARE = new Set(["<", "<=", ">", ">=", "==", "!="]);

/** A call argument or result template the search can build and resolve: interpreter data, but also
 *  binary arithmetic (`(- $s 2)`, `(+ (+ $fs $xs) 1)`) anywhere inside, folded to an int once its
 *  operands bind. Like `nondetIsData` but with `+`/`-`/`*` permitted; any other grounded op, rule call,
 *  or higher-order head is outside the subset. */
function nondetArgOk(env: MinEnv, a: Atom): boolean {
  if (a.kind !== "expr" || a.items.length === 0) return true;
  const h = a.items[0]!;
  if (h.kind === "expr" && h.items.length > 0) return false;
  if (h.kind === "sym") {
    if (ARITH_FOLD.has(h.name)) {
      if (a.items.length !== 3) return false;
    } else if (env.ruleIndex.has(h.name) || env.gt.has(h.name) || IMPURE_OPS.has(h.name))
      return false;
  }
  return a.items.every((x) => nondetArgOk(env, x));
}

/** A comparison guard `(cmp x y)` over search arguments: the condition an `(if ...)` node tests. */
function nondetGuardOk(env: MinEnv, cond: Atom): boolean {
  return (
    cond.kind === "expr" &&
    cond.items.length === 3 &&
    cond.items[0]!.kind === "sym" &&
    NONDET_COMPARE.has((cond.items[0] as SymAtom).name) &&
    nondetArgOk(env, cond.items[1]!) &&
    nondetArgOk(env, cond.items[2]!)
  );
}

const isEmptyCall = (a: Atom): boolean =>
  a.kind === "expr" &&
  a.items.length === 1 &&
  a.items[0]!.kind === "sym" &&
  (a.items[0] as SymAtom).name === "empty";

// A call targets any functor in the compiled group (so mutually-recursive chainers like obc/obc-gtz
// dispatch across each other), a `(match ...)` space query, or bails.
function nondetCall(env: MinEnv, group: ReadonlySet<string>, val: Atom): NondetCall | undefined {
  if (val.kind !== "expr" || val.items.length === 0 || val.items[0]!.kind !== "sym")
    return undefined;
  const op = (val.items[0] as SymAtom).name;
  if (op === "match" && val.items.length === 4) {
    if (!nondetIsData(env, val.items[2]!) || !nondetIsData(env, val.items[3]!)) return undefined;
    return {
      tag: "match",
      space: val.items[1]!,
      pattern: val.items[2]!,
      template: val.items[3]!,
    };
  }
  if (group.has(op)) {
    const args = val.items.slice(1);
    if (!args.every((x) => nondetArgOk(env, x))) return undefined;
    return { tag: "call", fn: op, args };
  }
  return undefined;
}

/** Unwrap a clause RHS into a body tree: an `(if guard then else)` node, or a let/let* goal chain
 *  ending in a tail (a template, a terminal call, or `(empty)` for no solutions). An `(if ...)` nested
 *  after goals is outside the subset and bails. */
function nondetUnwrap(env: MinEnv, group: ReadonlySet<string>, rhs: Atom): NondetBody | undefined {
  if (
    rhs.kind === "expr" &&
    rhs.items.length === 4 &&
    rhs.items[0]!.kind === "sym" &&
    (rhs.items[0] as SymAtom).name === "if"
  ) {
    if (!nondetGuardOk(env, rhs.items[1]!)) return undefined;
    const then = nondetUnwrap(env, group, rhs.items[2]!);
    const els = nondetUnwrap(env, group, rhs.items[3]!);
    if (then === undefined || els === undefined) return undefined;
    return { tag: "if", cond: rhs.items[1]!, then, els };
  }
  const goals: NondetGoal[] = [];
  let cur = rhs;
  for (;;) {
    if (cur.kind !== "expr" || cur.items.length === 0 || cur.items[0]!.kind !== "sym") break;
    const op = (cur.items[0] as SymAtom).name;
    if (op === "let*" && cur.items.length === 3 && cur.items[1]!.kind === "expr") {
      for (const pv of cur.items[1]!.items) {
        if (pv.kind !== "expr" || pv.items.length !== 2) return undefined;
        if (!nondetIsData(env, pv.items[0]!)) return undefined;
        const call = nondetCall(env, group, pv.items[1]!);
        if (call === undefined) return undefined;
        goals.push({ pat: pv.items[0]!, call });
      }
      cur = cur.items[2]!;
      continue;
    }
    if (op === "let" && cur.items.length === 4) {
      if (!nondetIsData(env, cur.items[1]!)) return undefined;
      const call = nondetCall(env, group, cur.items[2]!);
      if (call === undefined) return undefined;
      goals.push({ pat: cur.items[1]!, call });
      cur = cur.items[3]!;
      continue;
    }
    break;
  }
  if (isEmptyCall(cur)) return { tag: "seq", goals, tail: { tag: "empty" } };
  const tailCall = nondetCall(env, group, cur);
  if (tailCall !== undefined) return { tag: "seq", goals, tail: tailCall };
  // A result template may embed arithmetic (`(MkSized (+ (+ $fs $xs) 1) ...)`), folded when emitted.
  if (!nondetArgOk(env, cur)) return undefined;
  return { tag: "seq", goals, tail: { tag: "tpl", atom: cur } };
}

/** Whether a body issues any call (vs emitting templates only); a group with no calls anywhere is
 *  compileSymbolic's job, not this searching holder's. */
function nondetBodyHasCalls(body: NondetBody): boolean {
  if (body.tag === "if") return nondetBodyHasCalls(body.then) || nondetBodyHasCalls(body.els);
  return body.goals.length > 0 || body.tail.tag === "call" || body.tail.tag === "match";
}

function nondetCallArityOk(call: NondetCall, arityByFn: ReadonlyMap<string, number>): boolean {
  return call.tag !== "call" || call.args.length === arityByFn.get(call.fn);
}

/** Keep wrong-arity calls on the evaluator path, where they retain normal irreducible-call semantics. */
function nondetBodyCallAritiesOk(
  body: NondetBody,
  arityByFn: ReadonlyMap<string, number>,
): boolean {
  if (body.tag === "if")
    return (
      nondetBodyCallAritiesOk(body.then, arityByFn) && nondetBodyCallAritiesOk(body.els, arityByFn)
    );
  if (!body.goals.every((goal) => nondetCallArityOk(goal.call, arityByFn))) return false;
  return body.tail.tag !== "call" || nondetCallArityOk(body.tail, arityByFn);
}

const callAtoms = (call: NondetCall): readonly Atom[] =>
  call.tag === "call" ? call.args : [call.space, call.pattern, call.template];

const atomsUseVars = (atoms: readonly Atom[], names: ReadonlySet<string>): boolean =>
  atoms.some((atom) => atomVars(atom).some((name) => names.has(name)));

/** Detect a dependent search join. A variable absent from the clause head but introduced in one goal's
 *  call or result pattern is a clause-local answer field. If a later recursive call consumes it, keys fan out
 *  with the prior answer instead of repeating an input-only subproblem. Direct DFS avoids retaining that
 *  intermediate answer relation. Independent calls such as fib(n-1) and fib(n-2) remain table-first. */
function nondetBodyHasAnswerDependentCall(
  body: NondetBody,
  headVars: ReadonlySet<string>,
): boolean {
  if (body.tag === "if")
    return (
      nondetBodyHasAnswerDependentCall(body.then, headVars) ||
      nondetBodyHasAnswerDependentCall(body.els, headVars)
    );

  const known = new Set(headVars);
  const produced = new Set<string>();
  for (const goal of body.goals) {
    const atoms = callAtoms(goal.call);
    if (goal.call.tag === "call" && atomsUseVars(atoms, produced)) return true;
    for (const atom of [...atoms, goal.pat])
      for (const name of atomVars(atom))
        if (!known.has(name)) {
          known.add(name);
          produced.add(name);
        }
  }
  return body.tail.tag === "call" && atomsUseVars(body.tail.args, produced);
}

/** Whether a body queries a space via `(match ...)`. A group whose search is pure rule recursion (no
 *  match) runs on the zero-allocation Trail (`makeTrailRun`); one that queries spaces stays on the
 *  immutable matcher, which the injected `matchSolutions` returns bindings for. */
function nondetBodyUsesMatch(body: NondetBody): boolean {
  if (body.tag === "if") return nondetBodyUsesMatch(body.then) || nondetBodyUsesMatch(body.els);
  if (body.tail.tag === "match") return true;
  return body.goals.some((g) => g.call.tag === "match");
}

// ---------- clause skeletons (the trail run's compiled clause form) ----------
// A clause atom precompiled for the cell search, so a dispatch never copies clause text: `t: 0` is a
// constant subtree (variable-free, shared as-is), `t: 1` is a clause-variable slot in the dispatch's
// frame array, `t: 2` is a structured node with variables beneath (`arith` set when it is a foldable
// binary integer node). Head and pattern skeletons unify directly against terms (WAM read mode; a subtree
// materializes only when it binds into a variable — write mode), and body arguments/templates instantiate
// through the frame. This is what makes a failed clause attempt nearly free: it fails at the first
// mismatch having allocated nothing but the frame.
export type Skel =
  | { readonly t: 0; readonly a: Atom }
  | { readonly t: 1; readonly i: number }
  | { readonly t: 2; readonly items: readonly Skel[]; readonly arith: string | undefined };

export interface SkelGoal {
  readonly pat: Skel;
  /** Empty string when `match` is set: a space-match goal has no dispatched function. */
  readonly fn: string;
  readonly args: readonly Skel[];
  /** A `(match space pattern template)` goal, served by the injected immutable matcher with the
   *  solutions bound back onto the cells. The JIT declines any group carrying one, so only the
   *  skeleton interpreter and the immutable engine ever see it. */
  readonly match?: { readonly space: Skel; readonly pattern: Skel; readonly template: Skel };
}

export type SkelTail =
  | { readonly tag: "tpl"; readonly tpl: Skel }
  | { readonly tag: "empty" }
  | { readonly tag: "call"; readonly fn: string; readonly args: readonly Skel[] }
  | {
      readonly tag: "match";
      readonly space: Skel;
      readonly pattern: Skel;
      readonly template: Skel;
    };

export type SkelBody =
  | { readonly tag: "seq"; readonly goals: readonly SkelGoal[]; readonly tail: SkelTail }
  | {
      readonly tag: "if";
      readonly op: string;
      readonly x: Skel;
      readonly y: Skel;
      readonly then: SkelBody;
      readonly els: SkelBody;
    };

export interface SkelClause {
  /** Number of clause-variable slots (the dispatch frame's length). */
  readonly n: number;
  /** Head argument skeletons (the head symbol is implied by the dispatch table). */
  readonly lhsArgs: readonly Skel[];
  readonly body: SkelBody;
}

function skelOf(a: Atom, idx: Map<string, number>): Skel {
  if (a.kind === "var") {
    let i = idx.get(a.name);
    if (i === undefined) {
      i = idx.size;
      idx.set(a.name, i);
    }
    return { t: 1, i };
  }
  if (a.kind === "expr") {
    const h = a.items[0];
    const arith =
      a.items.length === 3 && h !== undefined && h.kind === "sym" && ARITH_FOLD.has(h.name)
        ? h.name
        : undefined;
    // A ground non-arith subtree is a shared constant; a ground arith node still folds at instantiation.
    if (a.ground && arith === undefined) return { t: 0, a };
    return { t: 2, items: a.items.map((x) => skelOf(x, idx)), arith };
  }
  return { t: 0, a };
}

function skelBodyOf(b: NondetBody, idx: Map<string, number>): SkelBody | undefined {
  if (b.tag === "if") {
    const c = b.cond;
    if (c.kind !== "expr" || c.items.length !== 3 || c.items[0]!.kind !== "sym") return undefined;
    const x = skelOf(c.items[1]!, idx);
    const y = skelOf(c.items[2]!, idx);
    const then = skelBodyOf(b.then, idx);
    if (then === undefined) return undefined;
    const els = skelBodyOf(b.els, idx);
    if (els === undefined) return undefined;
    return { tag: "if", op: (c.items[0] as SymAtom).name, x, y, then, els };
  }
  const goals: SkelGoal[] = [];
  for (const g of b.goals) {
    if (g.call.tag === "match") {
      goals.push({
        pat: skelOf(g.pat, idx),
        fn: "",
        args: [],
        match: {
          space: skelOf(g.call.space, idx),
          pattern: skelOf(g.call.pattern, idx),
          template: skelOf(g.call.template, idx),
        },
      });
      continue;
    }
    goals.push({
      pat: skelOf(g.pat, idx),
      fn: g.call.fn,
      args: g.call.args.map((x) => skelOf(x, idx)),
    });
  }
  const tl = b.tail;
  const tail: SkelTail =
    tl.tag === "match"
      ? {
          tag: "match",
          space: skelOf(tl.space, idx),
          pattern: skelOf(tl.pattern, idx),
          template: skelOf(tl.template, idx),
        }
      : tl.tag === "tpl"
        ? { tag: "tpl", tpl: skelOf(tl.atom, idx) }
        : tl.tag === "empty"
          ? { tag: "empty" }
          : { tag: "call", fn: tl.fn, args: tl.args.map((x) => skelOf(x, idx)) };
  return { tag: "seq", goals, tail };
}

/** Compile every clause of a (match-free) group to skeletons, or `undefined` when any clause falls
 *  outside the skeleton form (the group then runs on the immutable holder). */
function compileSkels(
  clausesByFn: ReadonlyMap<string, NondetClause[]>,
): Map<string, SkelClause[]> | undefined {
  const out = new Map<string, SkelClause[]>();
  for (const [fn, cls] of clausesByFn) {
    const scls: SkelClause[] = [];
    for (const c of cls) {
      if (c.lhs.kind !== "expr" || c.lhs.items.length === 0 || c.lhs.items[0]!.kind !== "sym")
        return undefined;
      const idx = new Map<string, number>();
      const lhsArgs = c.lhs.items.slice(1).map((x) => skelOf(x, idx));
      const body = skelBodyOf(c.body, idx);
      if (body === undefined) return undefined;
      scls.push({ n: idx.size, lhsArgs, body });
    }
    out.set(fn, scls);
  }
  return out;
}

/** Compile a functor whose every clause is a let/let* chain of self-calls and space matches over a
 *  data template. Sound only when `candidatesW` for the call equals exactly the static clauses (the
 *  eval call site declines when runtime rules can affect the operator; variable-headed catch-alls
 *  disable compilation entirely). */
const isIntAtom = (a: Atom): boolean => a.kind === "gnd" && (a.value as { g: string }).g === "int";

// Special forms the search handles inline (guard nodes, goal chains, arithmetic folding, `runMatch`),
// never as a dispatched group subgoal. `if` in particular is rule-defined in the stdlib, so it would
// otherwise be pulled into the group as a callee. Excluded from group discovery; their arguments are
// still scanned for the real recursive callees.
const NONDET_INLINE = new Set([
  "if",
  "let",
  "let*",
  "match",
  "empty",
  ...ARITH_FOLD,
  ...NONDET_COMPARE,
]);

/** Rule-defined functors dispatched anywhere in `a` (an expr head in `env.ruleIndex`, excluding the
 *  inline special forms). A `nondetIsData` template never contains a rule functor, so for an eligible
 *  clause "mentioned" equals "called". */
function collectCalledFunctors(env: MinEnv, a: Atom, into: Set<string>): void {
  if (a.kind !== "expr" || a.items.length === 0) return;
  const h = a.items[0]!;
  if (h.kind === "sym" && !NONDET_INLINE.has(h.name) && env.ruleIndex.has(h.name)) into.add(h.name);
  for (const it of a.items) collectCalledFunctors(env, it, into);
}

/** The mutually-recursive group reachable from `root`: its call-graph closure over rule functors, so
 *  obc/obc-gtz (each calls the other) compile together and dispatch across each other at runtime. */
function discoverNondetGroup(env: MinEnv, root: string): Set<string> {
  const group = new Set<string>([root]);
  const queue = [root];
  while (queue.length > 0) {
    const fn = queue.pop()!;
    for (const [, rhs] of env.ruleIndex.get(fn) ?? []) {
      const called = new Set<string>();
      collectCalledFunctors(env, rhs, called);
      for (const g of called)
        if (!group.has(g)) {
          group.add(g);
          queue.push(g);
        }
    }
  }
  return group;
}

// Compile a mutually-recursive group of searching functors (the closure from `root`) into one holder
// per functor, all sharing the group's clause map so a call dispatches across functors. Handles the
// `(if guard then else)` size guards and the integer arithmetic (`(- $s 2)`, `(+ (+ $fs $xs) 1)`) of the
// proof-size-bounded chainers, evaluated through the interpreter's own grounded ops for byte-identity.
// Returns undefined (bail to the interpreter) if any group functor is outside the subset.
function compileNondetGroup(
  env: MinEnv,
  root: string,
  requireDirectForModed = false,
): Map<string, NondetHolder> | undefined {
  if (env.varRulesVar.length !== 0) return undefined;
  if ((env.ruleIndex.get(root)?.length ?? 0) === 0) return undefined;
  const group = discoverNondetGroup(env, root);
  const clausesByFn = new Map<string, NondetClause[]>();
  const arityByFn = new Map<string, number>();
  let anyCalls = false;
  let preferDirectForModed = false;
  for (const fn of group) {
    const eqs = env.ruleIndex.get(fn);
    if (eqs === undefined || eqs.length === 0) return undefined;
    const clauses: NondetClause[] = [];
    let arity: number | undefined;
    for (const [lhs, rhs] of eqs) {
      if (lhs.kind !== "expr" || lhs.items.length === 0) return undefined;
      const h = lhs.items[0]!;
      if (h.kind !== "sym" || h.name !== fn) return undefined;
      const a = lhs.items.length - 1;
      if (arity === undefined) arity = a;
      else if (a !== arity) return undefined;
      if (!lhs.items.slice(1).every((x) => nondetIsData(env, x))) return undefined;
      const body = nondetUnwrap(env, group, rhs);
      if (body === undefined) return undefined;
      if (nondetBodyHasCalls(body)) anyCalls = true;
      if (nondetBodyHasAnswerDependentCall(body, new Set(atomVars(lhs))))
        preferDirectForModed = true;
      clauses.push({ lhs, body });
    }
    if (arity === undefined) return undefined;
    clausesByFn.set(fn, clauses);
    arityByFn.set(fn, arity);
  }
  for (const clauses of clausesByFn.values())
    if (!clauses.every((clause) => nondetBodyCallAritiesOk(clause.body, arityByFn)))
      return undefined;
  // A group with template-only clauses is compileSymbolic's job; this holder earns its keep only when
  // bodies actually search.
  if (!anyCalls) return undefined;
  if (requireDirectForModed && !preferDirectForModed) return undefined;

  const makeRun =
    (entry: string) =>
    (
      envR: MinEnv,
      partAtoms: readonly Atom[],
      st: St,
      ops: CompiledImpureOps,
      fuel?: number,
    ): CompiledRunResult | undefined => {
      // Honor a caller-provided search allowance above the fixed hedge. Once that allowance is spent,
      // compiled recursion continues only while the active call path proves a natural-number descent.
      const cap = fuel === undefined || fuel < NONDET_CALL_CAP ? NONDET_CALL_CAP : fuel;
      const matchSolutions = ops.matchSolutions;
      if (matchSolutions === undefined) return undefined;
      const ctr = { c: st.counter };
      let dispatches = 0;
      let rootDispatch = true;
      const active: AtomRecurrenceFrame[] = [];
      const world = st.world;
      const evaluationDepth = ops.evaluationDepth;
      const depthLimit = ops.maxStackDepth ?? 0;

      // Deep resolution through the accumulated bindings (miniKanren's walk*): a goal can bind a
      // variable that an earlier goal already stored INSIDE a bound value, so a shallow instantiate
      // would emit the stale intermediate variable. The interpreter never sees such chains because its
      // `chain` plumbing substitutes each concrete value structurally; here the bindings thread instead,
      // so emitted terms and goal inputs resolve through value chains to their final form. A binary
      // arithmetic node whose operands have resolved to concrete ints folds through the grounded op,
      // matching how the interpreter evaluates a `(- $s 2)` argument or a `(+ ...)` result size.
      const walk = (b: Bindings, a: Atom): Atom => {
        let v = a;
        let hops = 0;
        while (v.kind === "var") {
          const next = lookupVal(b, v.name);
          if (next === undefined) return v;
          v = next;
          if (++hops > 10_000) throw BAIL; // a cyclic chain escaped the loop checks: not our subset
        }
        return v;
      };
      const foldArith = (op: string, x: Atom, y: Atom): Atom => {
        if (!isIntAtom(x) || !isIntAtom(y)) throw BAIL; // arithmetic on non-ints: outside the subset
        const r = callGrounded(envR.gt, op, [x, y]);
        if (r.tag !== "ok" || r.results.length !== 1) throw BAIL;
        return r.results[0]!;
      };
      const walkStar = (b: Bindings, a: Atom): Atom => {
        const v = walk(b, a);
        if (v.kind !== "expr") return v;
        const its = v.items;
        const h = its[0];
        const isArith =
          its.length === 3 && h !== undefined && h.kind === "sym" && ARITH_FOLD.has(h.name);
        if (v.ground && !isArith) return v;
        let items: Atom[] | null = null;
        for (let i = 0; i < its.length; i++) {
          const it = its[i]!;
          const r = walkStar(b, it);
          if (items !== null) items.push(r);
          else if (r !== it) {
            items = its.slice(0, i);
            items.push(r);
          }
        }
        if (isArith) {
          const xs = items ?? its;
          return foldArith((h as SymAtom).name, xs[1]!, xs[2]!);
        }
        return items === null ? v : expr(items);
      };
      const resolve = (b: Bindings, a: Atom, suffix: string): Atom =>
        walkStar(b, instantiate(b, a, suffix));

      // A `(cmp x y)` guard: resolve both operands (folding any arithmetic) and evaluate the comparison
      // through the grounded op, exactly as the interpreter reduces the `(if ...)` condition.
      const evalGuard = (b: Bindings, cond: Atom, suffix: string): boolean => {
        if (cond.kind !== "expr" || cond.items[0]!.kind !== "sym") throw BAIL;
        const op = cond.items[0]!.name;
        const r = callGrounded(envR.gt, op, [
          resolve(b, cond.items[1]!, suffix),
          resolve(b, cond.items[2]!, suffix),
        ]);
        if (r.tag !== "ok" || r.results.length !== 1) throw BAIL;
        const res = r.results[0]!;
        if (res.kind !== "gnd" || (res.value as { g: string }).g !== "bool") throw BAIL;
        return (res.value as { g: string; b: boolean }).b;
      };

      const runMatch = (
        b: Bindings,
        suffix: string,
        call: { space: Atom; pattern: Atom; template: Atom },
      ): ReadonlyArray<readonly [Atom, Bindings]> => {
        const m = matchSolutions(
          envR,
          { counter: ctr.c, world },
          resolve(b, call.space, suffix),
          resolve(b, call.pattern, suffix),
          resolve(b, call.template, suffix),
        );
        if (m === undefined) throw BAIL;
        ctr.c += m.counterDelta;
        return m.pairs;
      };

      const solveSeq = (
        goals: readonly NondetGoal[],
        tail: NondetTail,
        gi: number,
        b: Bindings,
        suffix: string,
        out: Array<readonly [Atom, Bindings]>,
      ): void => {
        if (gi === goals.length) {
          if (tail.tag === "empty") return;
          if (tail.tag === "tpl") {
            out.push([resolve(b, tail.atom, suffix), b]);
            return;
          }
          const pairs =
            tail.tag === "match"
              ? runMatch(b, suffix, tail)
              : runCall(
                  tail.fn,
                  tail.args.map((x) => resolve(b, x, suffix)),
                );
          for (const [atom, vb] of pairs)
            // `b` is loop-free by induction over this search's checks, so the incremental form applies.
            for (const mm of merge(b, vb)) if (!hasLoopFromBase(mm, b)) out.push([atom, mm]);
          return;
        }
        const goal = goals[gi]!;
        const pat = resolve(b, goal.pat, suffix);
        const pairs =
          goal.call.tag === "match"
            ? runMatch(b, suffix, goal.call)
            : runCall(
                goal.call.fn,
                goal.call.args.map((x) => resolve(b, x, suffix)),
              );
        for (const [atom, vb] of pairs)
          for (const withVal of merge(b, vb)) {
            // `b` enters loop-free (checked on every path in), and `withVal` is checked here before it
            // becomes the next merge's base, so both incremental calls satisfy the loop-free-base rule.
            if (hasLoopFromBase(withVal, b)) continue;
            for (const pm of matchAtoms(pat, atom))
              for (const mm of merge(withVal, pm))
                if (!hasLoopFromBase(mm, withVal)) solveSeq(goals, tail, gi + 1, mm, suffix, out);
          }
      };

      const execBody = (
        body: NondetBody,
        b: Bindings,
        suffix: string,
        out: Array<readonly [Atom, Bindings]>,
      ): void => {
        if (body.tag === "if") {
          execBody(evalGuard(b, body.cond, suffix) ? body.then : body.els, b, suffix, out);
          return;
        }
        solveSeq(body.goals, body.tail, 0, b, suffix, out);
      };

      function runCall(fn: string, args: readonly Atom[]): Array<readonly [Atom, Bindings]> {
        const isRoot = rootDispatch;
        rootDispatch = false;
        if (!isRoot && evaluationDepth !== undefined) {
          const boundary = evaluationDepth.enterBoundary(depthLimit, EVALUATION_TRAMPOLINE_DEPTH);
          if (boundary !== undefined)
            throwEvaluationDepthBoundary(boundary, expr([sym(fn), ...args]), {
              counter: ctr.c,
              world,
            });
        }
        const guarded = ++dispatches > cap;
        const guardFrame = guarded ? enterAtomNaturalRecurrence(active, fn, args) : undefined;
        try {
          if (guarded && guardFrame === undefined) throw BAIL;
          const cls = clausesByFn.get(fn);
          if (cls === undefined) throw BAIL;
          const app = expr([sym(fn), ...args]);
          const out: Array<readonly [Atom, Bindings]> = [];
          for (const clause of cls) {
            const suffix = "#" + ctr.c;
            ctr.c += 1;
            for (const b0 of matchAtomsScoped(clause.lhs, app, suffix))
              if (!hasLoop(b0)) execBody(clause.body, b0, suffix, out);
          }
          return out;
        } finally {
          if (guarded && guardFrame !== undefined) active.pop();
          if (!isRoot) evaluationDepth?.leave();
        }
      }

      try {
        const top = runCall(entry, partAtoms);
        const results: CompiledAtomResult[] = top.map(([atom, bnd]) => ({ atom, bnd }));
        return { results, counterDelta: ctr.c - st.counter };
      } catch (e) {
        // BAIL: outside the proven subset (or over budget); RangeError: native stack exhaustion. The
        // search mutated nothing, so re-running interpreted is sound.
        if (e === BAIL || e instanceof RangeError) return undefined;
        throw e;
      }
    };

  // A pure rule-recursion group (no space `match`) runs on the zero-allocation Trail: bindings are made
  // in place and undone on backtrack, unification carries the occurs check that the immutable path spends
  // a separate O(binding-set) `hasLoop` scan on, and only a kept result materializes. On the proof-size
  // chainers this is ~25x the immutable holder and byte-identical (differential-gated). CPS: `k` fires at
  // each solution with the resolved result while the trail still holds its bindings.
  const makeSkelRun =
    (entry: string, skelsByFn: Map<string, SkelClause[]>) =>
    (
      envR: MinEnv,
      partAtoms: readonly Atom[],
      st: St,
      ops?: CompiledImpureOps,
      fuel?: number,
    ): CompiledRunResult | undefined => {
      const world = st.world;
      const matchSolutionsOp = ops?.matchSolutions;
      // Match the copying runner's fixed hedge and caller-provided search allowance.
      const cap = fuel === undefined || fuel < NONDET_CALL_CAP ? NONDET_CALL_CAP : fuel;
      // The trail: bound cells in bind order; undoing to a mark pops and clears each cell's slot.
      const cellTrail: CellVar[] = [];
      const ctr = { c: st.counter };
      // Names for cells that survive unbound into a materialized answer, assigned lazily on first
      // materialization. A separate counter from `ctr` so `counterDelta` (which the interpreter's gensym
      // lockstep depends on, per-dispatch only) is untouched by how many answer variables get named.
      let cellNameC = 0;
      let dispatches = 0;
      let rootDispatch = true;
      const active: AtomRecurrenceFrame[] = [];
      const results: CompiledAtomResult[] = [];
      const queryVars = atomVars(expr(partAtoms as Atom[]));
      const evaluationDepth = ops?.evaluationDepth;
      const depthLimit = ops?.maxStackDepth ?? 0;

      // Inline integer +/-/* (dispatching through `callGrounded` per node is the search's dominant cost —
      // obc folds several sizes per mp step). Byte-identical: `callGrounded` routes +/-/* to these same
      // `addInt`/`subInt`/`mulInt`. A non-int operand BAILs to the interpreter, unchanged.
      const foldArith = (op: string, x: Atom, y: Atom): Atom => {
        if (
          x.kind !== "gnd" ||
          (x.value as { g: string }).g !== "int" ||
          y.kind !== "gnd" ||
          (y.value as { g: string }).g !== "int"
        )
          throw BAIL;
        const xn = (x.value as { n: IntVal }).n;
        const yn = (y.value as { n: IntVal }).n;
        return gint(op === "+" ? addInt(xn, yn) : op === "-" ? subInt(xn, yn) : mulInt(xn, yn));
      };
      // Instantiate a skeleton against a dispatch frame. `fold` folds arith nodes (call arguments,
      // templates, guard operands — matching the copying run, which folded exactly there); write-mode
      // head/pattern subtrees instantiate unfolded. A bound cell inlines its value: every use of the
      // instantiated term happens while the binding is still live (bindings undo LIFO, strictly after the
      // continuations that consumed the term return), and inlining tightens `ground` flags so occurs
      // checks and later dereferences short-circuit. Only a kept solution materializes fully, at the entry.
      const instSkel = (sk: Skel, frame: (CellVar | undefined)[], fold: boolean): Atom => {
        if (sk.t === 0) return sk.a;
        if (sk.t === 1) {
          let c = frame[sk.i];
          if (c === undefined) {
            c = mkCell();
            frame[sk.i] = c;
          }
          return derefCell(c);
        }
        const its = sk.items;
        const out: Atom[] = new Array(its.length);
        for (let i = 0; i < its.length; i++) out[i] = instSkel(its[i]!, frame, fold);
        if (fold && sk.arith !== undefined)
          return foldArith(sk.arith, derefCell(out[1]!), derefCell(out[2]!));
        return expr(out);
      };
      // Unify a head/pattern skeleton directly against a term: read mode walks the term with no
      // allocation (a failed clause attempt costs the frame and nothing else); a skeleton subtree
      // materializes only when it binds into a term variable (write mode), occurs-checked like every
      // other bind.
      const unifySkel = (sk: Skel, frame: (CellVar | undefined)[], t0: Atom): boolean => {
        if (sk.t === 0) return unifyCellOccurs(cellTrail, sk.a, t0);
        if (sk.t === 1) {
          let c = frame[sk.i];
          if (c === undefined) {
            // First occurrence of this clause variable: the cell was just created, so it cannot occur in
            // `t0` — bind directly, skipping the provably-redundant occurs walk (what unifyCellOccurs
            // would do after occursCell returned false, including binding to the dereferenced value).
            c = mkCell();
            frame[sk.i] = c;
            c.b = derefCell(t0);
            cellTrail.push(c);
            return true;
          }
          return unifyCellOccurs(cellTrail, c, t0);
        }
        const t = derefCell(t0);
        if (t.kind === "var") {
          const s = instSkel(sk, frame, false);
          if (occursCell(t, s)) return false;
          (t as CellVar).b = s;
          cellTrail.push(t as CellVar);
          return true;
        }
        const its = sk.items;
        if (t.kind !== "expr" || t.items.length !== its.length) return false;
        for (let i = 0; i < its.length; i++)
          if (!unifySkel(its[i]!, frame, t.items[i]!)) return false;
        return true;
      };
      // Deep resolution through the cells (miniKanren walk*), folding a binary arithmetic node once its
      // operands are concrete ints, exactly as the immutable run's walkStar/foldArith. Used only to
      // materialize a kept solution (and its query-variable bindings) at the entry, once per answer; the
      // search itself passes lazy terms. An unbound cell gets its lazy name here and comes out as a plain
      // variable atom, so no mutable cell escapes the search.
      const resolveDeep = (a0: Atom): Atom => {
        const a = derefCell(a0);
        if (a.kind === "var") {
          const c = a as CellVar;
          if (c.name === "") {
            c.name = "_c#" + String(cellNameC);
            cellNameC += 1;
          }
          return variable(c.name);
        }
        if (a.kind !== "expr") return a;
        const its = a.items;
        const h = its[0];
        const isArith =
          its.length === 3 && h !== undefined && h.kind === "sym" && ARITH_FOLD.has(h.name);
        if (a.ground && !isArith) return a;
        let items: Atom[] | null = null;
        for (let i = 0; i < its.length; i++) {
          const r = resolveDeep(its[i]!);
          if (items !== null) items.push(r);
          else if (r !== its[i]) {
            items = its.slice(0, i);
            items.push(r);
          }
        }
        if (isArith) {
          const xs = items ?? its;
          return foldArith((h as SymAtom).name, xs[1]!, xs[2]!);
        }
        return items === null ? a : expr(items);
      };
      // Inline the integer comparison guard (obc's `(< 2 $s)` / `(< 0 $s)`); a non-int comparison BAILs.
      const evalGuard = (
        op: string,
        x0: Skel,
        y0: Skel,
        frame: (CellVar | undefined)[],
      ): boolean => {
        const x = derefCell(instSkel(x0, frame, true));
        const y = derefCell(instSkel(y0, frame, true));
        if (
          x.kind !== "gnd" ||
          (x.value as { g: string }).g !== "int" ||
          y.kind !== "gnd" ||
          (y.value as { g: string }).g !== "int"
        )
          throw BAIL;
        const c = cmpIntVal((x.value as { n: IntVal }).n, (y.value as { n: IntVal }).n);
        switch (op) {
          case "<":
            return c < 0;
          case "<=":
            return c <= 0;
          case ">":
            return c > 0;
          case ">=":
            return c >= 0;
          case "==":
            return c === 0;
          case "!=":
            return c !== 0;
          default:
            throw BAIL;
        }
      };

      // Materialize a lazy in-search term for the immutable matcher: every unbound cell (a nameless
      // variable atom in flight) becomes a plain named variable, recorded so the solution bindings the
      // matcher returns can be routed back onto the very cells they solve. Bound cells were already
      // inlined by instSkel; named variables can only be the matcher's own freshenings, kept as-is.
      let matNameC = 0;
      const matOut = (a: Atom, map: Map<string, CellVar>, names: Map<CellVar, string>): Atom => {
        if (a.ground) return a;
        if (a.kind === "var") {
          if (a.name !== "") return a;
          const cell = a as CellVar;
          let n = names.get(cell);
          if (n === undefined) {
            n = "_mq#" + String(matNameC);
            matNameC += 1;
            names.set(cell, n);
            map.set(n, cell);
          }
          return variable(n);
        }
        if (a.kind !== "expr") return a;
        const its = a.items;
        let items: Atom[] | null = null;
        for (let i = 0; i < its.length; i++) {
          const r = matOut(its[i]!, map, names);
          if (items !== null) items.push(r);
          else if (r !== its[i]) {
            items = its.slice(0, i);
            items.push(r);
          }
        }
        return items === null ? a : expr(items);
      };
      // The inverse direction: put the recorded cells back into a matcher-produced term, so later
      // goals dereference through them and the entry extracts their answers.
      const cellBack = (a: Atom, map: Map<string, CellVar>): Atom => {
        if (a.ground) return a;
        if (a.kind === "var") return map.get(a.name) ?? a;
        if (a.kind !== "expr") return a;
        const its = a.items;
        let items: Atom[] | null = null;
        for (let i = 0; i < its.length; i++) {
          const r = cellBack(its[i]!, map);
          if (items !== null) items.push(r);
          else if (r !== its[i]) {
            items = its.slice(0, i);
            items.push(r);
          }
        }
        return items === null ? a : expr(items);
      };
      // A space-match step: resolve the call through the cells, ask the injected immutable matcher
      // (advancing the counter by exactly what the interpreted match would have cost), then per
      // solution bind the pattern's cells from the solution's bindings on the trail and hand the
      // instantiated template to `use`. Undo between solutions, exactly like a clause dispatch.
      const runMatchSkel = (
        spec: { readonly space: Skel; readonly pattern: Skel; readonly template: Skel },
        frame: (CellVar | undefined)[],
        use: (value: Atom) => void,
      ): void => {
        if (matchSolutionsOp === undefined) throw BAIL;
        const map = new Map<string, CellVar>();
        const names = new Map<CellVar, string>();
        const space = matOut(instSkel(spec.space, frame, true), map, names);
        const pattern = matOut(instSkel(spec.pattern, frame, true), map, names);
        const template = matOut(instSkel(spec.template, frame, true), map, names);
        const sol = matchSolutionsOp(envR, { counter: ctr.c, world }, space, pattern, template);
        if (sol === undefined) throw BAIL;
        ctr.c += sol.counterDelta;
        for (const [value, vb] of sol.pairs) {
          const m = cellTrail.length;
          let ok = true;
          for (const [name, cell] of map) {
            const v = lookupVal(vb, name);
            if (v === undefined) continue;
            if (!unifyCellOccurs(cellTrail, cell, cellBack(v, map))) {
              ok = false;
              break;
            }
          }
          if (ok) use(cellBack(value, map));
          while (cellTrail.length > m) cellTrail.pop()!.b = undefined;
        }
      };

      const solveSeq = (
        goals: readonly SkelGoal[],
        tail: SkelTail,
        gi: number,
        frame: (CellVar | undefined)[],
        k: (r: Atom) => void,
      ): void => {
        if (gi === goals.length) {
          if (tail.tag === "empty") return;
          if (tail.tag === "tpl") {
            // Lazy: the caller's pattern-unify (or the entry's materialize) dereferences through the cells,
            // whose bindings are live for the whole continuation.
            k(instSkel(tail.tpl, frame, true));
            return;
          }
          if (tail.tag === "match") {
            runMatchSkel(tail, frame, k);
            return;
          }
          const targs: Atom[] = new Array(tail.args.length);
          for (let i = 0; i < targs.length; i++) targs[i] = instSkel(tail.args[i]!, frame, true);
          runCall(tail.fn, targs, k);
          return;
        }
        const goal = goals[gi]!;
        if (goal.match !== undefined) {
          runMatchSkel(goal.match, frame, (value) => {
            const m = cellTrail.length;
            if (unifySkel(goal.pat, frame, value)) solveSeq(goals, tail, gi + 1, frame, k);
            while (cellTrail.length > m) cellTrail.pop()!.b = undefined;
          });
          return;
        }
        const gargs: Atom[] = new Array(goal.args.length);
        for (let i = 0; i < gargs.length; i++) gargs[i] = instSkel(goal.args[i]!, frame, true);
        runCall(goal.fn, gargs, (res) => {
          const m = cellTrail.length;
          if (unifySkel(goal.pat, frame, res)) solveSeq(goals, tail, gi + 1, frame, k);
          while (cellTrail.length > m) cellTrail.pop()!.b = undefined;
        });
      };

      const execBody = (
        body: SkelBody,
        frame: (CellVar | undefined)[],
        k: (r: Atom) => void,
      ): void => {
        if (body.tag === "if") {
          execBody(evalGuard(body.op, body.x, body.y, frame) ? body.then : body.els, frame, k);
          return;
        }
        solveSeq(body.goals, body.tail, 0, frame, k);
      };

      function runCall(fn: string, args: readonly Atom[], k: (r: Atom) => void): void {
        const isRoot = rootDispatch;
        rootDispatch = false;
        if (!isRoot && evaluationDepth !== undefined) {
          const boundary = evaluationDepth.enterBoundary(depthLimit, EVALUATION_TRAMPOLINE_DEPTH);
          if (boundary !== undefined)
            throwEvaluationDepthBoundary(boundary, expr([sym(fn), ...args]), {
              counter: ctr.c,
              world,
            });
        }
        const guarded = ++dispatches > cap;
        const guardFrame = guarded ? enterAtomNaturalRecurrence(active, fn, args) : undefined;
        let guardActive = guardFrame !== undefined;
        const emit =
          guardFrame === undefined
            ? k
            : (result: Atom) => {
                active.pop();
                guardActive = false;
                try {
                  k(result);
                } finally {
                  active.push(guardFrame);
                  guardActive = true;
                }
              };
        try {
          if (guarded && guardFrame === undefined) throw BAIL;
          const cls = skelsByFn.get(fn);
          if (cls === undefined) throw BAIL;
          for (const clause of cls) {
            ctr.c += 1; // per-dispatch advance, exactly as the copying run did: counterDelta unchanged
            const la = clause.lhsArgs;
            if (la.length !== args.length) continue;
            const frame: (CellVar | undefined)[] = new Array(clause.n).fill(undefined);
            const m = cellTrail.length;
            let ok = true;
            for (let i = 0; i < la.length; i++)
              if (!unifySkel(la[i]!, frame, args[i]!)) {
                ok = false;
                break;
              }
            if (ok) execBody(clause.body, frame, emit);
            while (cellTrail.length > m) cellTrail.pop()!.b = undefined;
          }
        } finally {
          if (guardActive) active.pop();
          if (!isRoot) evaluationDepth?.leave();
        }
      }

      try {
        // Freshen the entry call's own variables into cells too, so binding them never mutates an
        // engine-owned atom; `entryFrame` maps each query variable to its cell for answer extraction.
        const entryFrame = new Map<string, CellVar>();
        const freshenEntry = (a: Atom): Atom => {
          if (a.ground) return a;
          if (a.kind === "var") {
            let c = entryFrame.get(a.name);
            if (c === undefined) {
              c = mkCell();
              entryFrame.set(a.name, c);
            }
            return c;
          }
          if (a.kind === "expr") return expr(a.items.map(freshenEntry));
          return a;
        };
        const entryArgs = partAtoms.map(freshenEntry);
        runCall(entry, entryArgs, (resultAtom) => {
          let bnd = emptyBindings;
          for (const v of queryVars) {
            const cell = entryFrame.get(v);
            if (cell === undefined) continue;
            const d = derefCell(cell);
            if (d === cell) continue; // unbound: no binding for v, as in the eager run
            bnd = prependValRaw(bnd, v, resolveDeep(d));
          }
          results.push({ atom: resolveDeep(resultAtom), bnd });
        });
        return { results, counterDelta: ctr.c - st.counter };
      } catch (e) {
        if (e === BAIL || e instanceof RangeError) return undefined;
        throw e;
      }
    };

  const matchFree = ![...clausesByFn.values()].some((cls) =>
    cls.some((c) => nondetBodyUsesMatch(c.body)),
  );
  // Every group's clauses compile to skeletons once, here, and every run dispatches over them. A group
  // that queries spaces runs the same trail search with its match goals served by the injected
  // immutable matcher; if that run bails, the immutable engine takes the dispatch unchanged.
  const skelsByFn = compileSkels(clausesByFn);
  // Specialized clause code for the group: the same search as the skeleton interpreter with per-node
  // dispatch compiled away. Match goals stay on the interpreter (the generated code has no bridge to
  // the immutable matcher). Under a CSP, new Function throws and compilation declines this group.
  const jitGroup =
    skelsByFn === undefined || !matchFree
      ? undefined
      : compileJitGroup(skelsByFn, arityByFn, BAIL, preferDirectForModed);

  // The boundary wrapper for a JIT'd group: entry arguments convert to slim terms once, each answer
  // materializes once (with the query-variable bindings extracted from the entry cells), and the
  // counter/dispatch box threads the per-clause-attempt discipline through the generated code.
  const makeJitRun =
    (entry: string, jg: JitGroup) =>
    (
      _envR: MinEnv,
      partAtoms: readonly Atom[],
      st: St,
      ops?: CompiledImpureOps,
      fuel?: number,
    ): CompiledRunResult | undefined => {
      const cap = fuel === undefined || fuel < NONDET_CALL_CAP ? NONDET_CALL_CAP : fuel;
      const queryVars = atomVars(expr(partAtoms as Atom[]));
      const fnNames = [...clausesByFn.keys()];
      const attempt = (
        strategy: "deferred" | "direct" | "frontier",
      ): CompiledRunResult | undefined => {
        const evaluationDepth = ops?.evaluationDepth;
        if (evaluationDepth !== undefined && strategy !== "direct") return undefined;
        let rootDispatch = true;
        const depthHooks =
          evaluationDepth === undefined
            ? {}
            : {
                enterDepth: (fn: number, args: readonly Slim[]): boolean => {
                  if (rootDispatch) {
                    rootDispatch = false;
                    return false;
                  }
                  const name = fnNames[fn];
                  if (name === undefined) throw BAIL;
                  const boundary = evaluationDepth.enterBoundary(
                    ops?.maxStackDepth ?? 0,
                    preferDirectForModed
                      ? NONDET_JIT_TRAMPOLINE_DEPTH
                      : EVALUATION_TRAMPOLINE_DEPTH,
                  );
                  if (boundary !== undefined)
                    throwEvaluationDepthBoundary(
                      boundary,
                      expr([sym(name), ...args.map((arg) => jitRuntime.atomOfSlim(arg, { c: 0 }))]),
                      { counter: stBox.c, world: st.world },
                    );
                  return true;
                },
                leaveDepth: (): void => evaluationDepth.leave(),
              };
        const stBox: JitSearchState = {
          c: st.counter,
          d: 0,
          cap,
          active: [],
          ...depthHooks,
        };
        const results: CompiledAtomResult[] = [];
        const entryCells = new Map<string, Slim>();
        const args = partAtoms.map((a) => jitRuntime.slimOfAtom(a, entryCells));
        const namer = { c: 0 };
        try {
          if (strategy === "frontier" && jg.prepareFrontier?.(entry, args, stBox) !== true)
            return undefined;
          const emit = (r: Slim): void => {
            let bnd = emptyBindings;
            for (const v of queryVars) {
              const cell = entryCells.get(v);
              if (cell === undefined) continue;
              const d = jitRuntime.derefS(cell);
              if (d === cell) continue; // unbound: no binding for v
              bnd = prependValRaw(bnd, v, jitRuntime.atomOfSlim(d, namer));
            }
            results.push({ atom: jitRuntime.atomOfSlim(r, namer), bnd });
          };
          if (strategy === "deferred") {
            if (jg.tryDeferred?.(entry, args, emit, stBox) !== true) return undefined;
          } else jg.call(entry, args, emit, stBox);
          return { results, counterDelta: stBox.c - st.counter };
        } catch (e) {
          if (e === BAIL || e instanceof RangeError) return undefined;
          throw e;
        }
      };

      return (
        (jg.tryDeferred === undefined ? undefined : attempt("deferred")) ??
        attempt("direct") ??
        attempt("frontier")
      );
    };

  // A match-bearing group prefers the trail search but keeps the immutable engine as its runtime
  // fallback: a BAIL inside the trail run (an unsupported guard, a matcher decline) retries the same
  // dispatch on the engine that served these groups before, instead of dropping to the interpreter.
  const makeSkelThenRun = (fn: string, skels: Map<string, SkelClause[]>): NondetHolder["run"] => {
    const skelRun = makeSkelRun(fn, skels);
    const immutableRun = makeRun(fn);
    return (envR, partAtoms, st, ops, fuel) =>
      skelRun(envR, partAtoms, st, ops, fuel) ?? immutableRun(envR, partAtoms, st, ops, fuel);
  };
  const holders = new Map<string, NondetHolder>();
  for (const fn of group)
    holders.set(fn, {
      kind: "nondet",
      arity: arityByFn.get(fn)!,
      clauseCount: clausesByFn.get(fn)!.length,
      preferDirectForModed,
      run:
        jitGroup !== undefined
          ? makeJitRun(fn, jitGroup)
          : skelsByFn !== undefined
            ? matchFree
              ? makeSkelRun(fn, skelsByFn)
              : makeSkelThenRun(fn, skelsByFn)
            : makeRun(fn),
    });
  return holders;
}

/** Compile one answer-dependent recursive search group for query-directed dispatch. Independent
 *  overlapping recursion stays on moded tabling and returns undefined, so the caller can use the full
 *  compiler when the query needs another compiled fragment. */
export function compileDependentNondetGroup(env: MinEnv, root: string): CompiledFns | undefined {
  const group = compileNondetGroup(env, root, true);
  if (group === undefined) return undefined;
  const compiled: CompiledFns = new Map();
  for (const [name, holder] of group) compiled.set(name, holder);
  return compiled;
}

// ---------- deterministic impure body compiler ----------

interface ImpScope {
  readonly vars: ReadonlyMap<string, number>;
  readonly len: number;
}
interface ImpCompiled {
  readonly node: ImpNode;
  readonly forEach?: ImpForEach;
  readonly directEffect: boolean;
  readonly callees: ReadonlySet<string>;
}
// `discard` (the void-context build): the caller throws the value away, so a tuple node may skip building its
// result (the cons) and run its elements only for their effects. It is forwarded to the result position
// (if/let body, tuple elements, call result), never to a value the body still needs (a let value, an if
// condition, call args). Defaults false, so omitting it leaves every node byte-identical to before.
type ImpNode = (
  slots: readonly Atom[],
  st: St,
  ops: CompiledImpureOps,
  discard?: boolean,
) => ImpEval;
type ImperativeFns = Map<string, ImperativeHolder>;

const IMP_GROUNDED = new Set(["==", "!=", "<", ">", "<=", ">=", "+", "-", "*", "%"]);
// Heads that are never inert data: the compiled language's own constructs, plus every evaluation
// op (IMPURE_OPS: match, collapse, once, superpose, metta, ...). Without the latter, a body like
// `(match &self p t)` whose head happens to have no rule and no grounding would freeze as a tuple,
// and compiled impure results skip re-reduction, so it would never run. Before the case/add-if-absent
// nodes below this was masked by `collapse` being rule-defined; it must hold on its own.
// Built lazily: the bundle's module order initializes this file before tabling.ts in the
// eval/builtins cycle, so a top-level spread of IMPURE_OPS would read it uninitialized.
let DATA_DENY_CACHE: Set<string> | undefined;
function dataDeny(): Set<string> {
  DATA_DENY_CACHE ??= new Set([...KNOWN_OPS, ...IMPURE_OPS, "let*", "add-atom"]);
  return DATA_DENY_CACHE;
}

// The value of a pruned branch: `(empty)` reduces to nothing, so a node yielding this sentinel has
// no result. It propagates through let/let* values, if conditions, and case branches (which prune
// it); any other consumer BAILs. At the holder boundary runCompiled maps it to zero results.
// Reference-compared, so no real `Empty` symbol a program builds can collide with it.
const EMPTY_VALUE: Atom = sym("Empty");

const addCounter = (st: St, n: number): St =>
  n === 0 ? st : { counter: st.counter + n, world: st.world };

const impBail = (): ImpEval => BAIL;

function impMeta(parts: readonly ImpCompiled[]): Pick<ImpCompiled, "directEffect" | "callees"> {
  const callees = new Set<string>();
  let directEffect = false;
  for (const part of parts) {
    if (part.directEffect) directEffect = true;
    for (const c of part.callees) callees.add(c);
  }
  return { directEffect, callees };
}

function impConst(atom: Atom): ImpCompiled {
  return { node: (_slots, st) => ({ value: atom, st }), directEffect: false, callees: new Set() };
}

function impForEach(
  part: ImpCompiled,
  slots: readonly Atom[],
  st: St,
  ops: CompiledImpureOps,
  discard: boolean | undefined,
  emit: ImpEmit,
): St | typeof BAIL {
  if (part.forEach !== undefined) return part.forEach(slots, st, ops, discard, emit);
  const r = part.node(slots, st, ops, discard);
  if (r === BAIL) return BAIL;
  return r.value === EMPTY_VALUE ? r.st : emit(r.value, r.st);
}

/** Assemble an expression from part nodes, threading state (the shared shape of the static-data and
 *  match-pattern builders; neither can yield an Empty part). */
function impAssembleExpr(parts: readonly ImpCompiled[]): ImpCompiled {
  return {
    node: (slots, st, ops) => {
      const out: Atom[] = [];
      let cur = st;
      for (const part of parts) {
        const r = part.node(slots, cur, ops);
        if (r === BAIL) return BAIL;
        out.push(r.value);
        cur = r.st;
      }
      return { value: expr(out), st: cur };
    },
    ...impMeta(parts),
  };
}

/** Evaluate argument nodes left to right, threading state. Every argument runs (its effects count)
 *  even when an earlier one came back Empty; an Empty anywhere makes the whole application empty. */
function impEvalArgs(
  parts: readonly ImpCompiled[],
  slots: readonly Atom[],
  st: St,
  ops: CompiledImpureOps,
): { vals: Atom[]; st: St; empty: boolean } | typeof BAIL {
  const vals: Atom[] = [];
  let cur = st;
  let empty = false;
  for (const part of parts) {
    const r = part.node(slots, cur, ops);
    if (r === BAIL) return BAIL;
    if (r.value === EMPTY_VALUE) empty = true;
    vals.push(r.value);
    cur = r.st;
  }
  return { vals, st: cur, empty };
}

function isDataSymbol(env: MinEnv, name: string): boolean {
  return !dataDeny().has(name) && !env.ruleIndex.has(name) && !env.gt.has(name);
}

function compileImpStaticAtom(env: MinEnv, a: Atom, scope: ImpScope): ImpCompiled | undefined {
  if (a.kind === "var") {
    const slot = scope.vars.get(a.name);
    if (slot === undefined) return undefined;
    return {
      node: (slots, st) => ({ value: slots[slot]!, st }),
      directEffect: false,
      callees: new Set(),
    };
  }
  if (a.kind === "sym") return isDataSymbol(env, a.name) ? impConst(a) : undefined;
  if (a.kind === "gnd") return impConst(a);
  if (a.items.length === 0) return impConst(a);
  const head = a.items[0]!;
  // A variable head may bind to a function symbol, so the term is a reducible application, not inert data
  // (same hazard as compileImpAtom; keeps the re-reduce-skip invariant that compiled impure results are
  // already normal form).
  if (head.kind === "var") return undefined;
  if (head.kind === "sym" && !isDataSymbol(env, head.name)) return undefined;
  const items = a.items.map((it) => compileImpStaticAtom(env, it, scope));
  if (items.some((it) => it === undefined)) return undefined;
  return impAssembleExpr(items as ImpCompiled[]);
}

function compileImpGrounded(
  env: MinEnv,
  op: string,
  args: readonly Atom[],
  scope: ImpScope,
  holders: ImperativeFns,
): ImpCompiled | undefined {
  if (env.ruleIndex.has(op)) return undefined;
  const parts = args.map((arg) => compileImpAtom(env, arg, scope, holders));
  if (parts.some((part) => part === undefined)) return undefined;
  const compiled = parts as ImpCompiled[];
  return {
    node: (slots, st, ops) => {
      const r = impEvalArgs(compiled, slots, st, ops);
      if (r === BAIL) return BAIL;
      // An Empty argument makes the whole application empty; the remaining args still ran (effects).
      if (r.empty) return { value: EMPTY_VALUE, st: r.st };
      const gr = callGrounded(env.gt, op, r.vals);
      return gr.tag === "ok" && gr.results.length === 1
        ? { value: gr.results[0]!, st: r.st }
        : BAIL;
    },
    ...impMeta(compiled),
  };
}

// Structural pieces of the add-if-absent idiom, matched over the RULE's atoms (variables in place):
// `(if (== () (collapse (once (match S A A)))) (add-atom S A) (empty))`. The same shape the
// interpreter's tryFastNamedAddIfAbsent recognises at runtime; compiled it becomes one ops call.
function impMatchInsideOnce(a: Atom): ExprAtom | undefined {
  if (a.kind !== "expr" || a.items.length !== 2) return undefined;
  const h = a.items[0]!;
  if (h.kind !== "sym" || h.name !== "once") return undefined;
  const inner = a.items[1]!;
  if (inner.kind !== "expr" || inner.items.length !== 4) return undefined;
  const ih = inner.items[0]!;
  return ih.kind === "sym" && ih.name === "match" ? inner : undefined;
}

function impEmptyCollapseMatch(a: Atom): ExprAtom | undefined {
  if (a.kind !== "expr" || a.items.length !== 3) return undefined;
  const h = a.items[0]!;
  if (h.kind !== "sym" || h.name !== "==") return undefined;
  const fromCollapse = (x: Atom): ExprAtom | undefined => {
    if (x.kind !== "expr" || x.items.length !== 2) return undefined;
    const ch = x.items[0]!;
    return ch.kind === "sym" && ch.name === "collapse"
      ? impMatchInsideOnce(x.items[1]!)
      : undefined;
  };
  if (atomEq(a.items[1]!, emptyExpr)) return fromCollapse(a.items[2]!);
  if (atomEq(a.items[2]!, emptyExpr)) return fromCollapse(a.items[1]!);
  return undefined;
}

function compileImpAddIfAbsent(
  env: MinEnv,
  args: readonly Atom[],
  scope: ImpScope,
): ImpCompiled | undefined {
  const match = impEmptyCollapseMatch(args[0]!);
  if (match === undefined) return undefined;
  const add = args[1]!;
  const otherwise = args[2]!;
  if (add.kind !== "expr" || add.items.length !== 3) return undefined;
  const addHead = add.items[0]!;
  if (addHead.kind !== "sym" || addHead.name !== "add-atom") return undefined;
  if (otherwise.kind !== "expr" || otherwise.items.length !== 1) return undefined;
  const oh = otherwise.items[0]!;
  if (oh.kind !== "sym" || oh.name !== "empty") return undefined;
  if (
    !atomEq(match.items[1]!, add.items[1]!) ||
    !atomEq(match.items[2]!, match.items[3]!) ||
    !atomEq(match.items[2]!, add.items[2]!)
  )
    return undefined;
  const space = compileImpStaticAtom(env, add.items[1]!, scope);
  const atom = compileImpStaticAtom(env, add.items[2]!, scope);
  if (space === undefined || atom === undefined) return undefined;
  return {
    node: (slots, st, ops) => {
      const addIfAbsent = ops.addIfAbsent;
      if (addIfAbsent === undefined) return BAIL;
      const s = space.node(slots, st, ops);
      if (s === BAIL) return BAIL;
      const a = atom.node(slots, s.st, ops);
      if (a === BAIL) return BAIL;
      const r = addIfAbsent(env, a.st, s.value, a.value);
      if (r === undefined) return BAIL;
      return { value: r.added ? emptyExpr : EMPTY_VALUE, st: r.state };
    },
    directEffect: true,
    callees: new Set(),
  };
}

function compileImpIf(
  env: MinEnv,
  args: readonly Atom[],
  scope: ImpScope,
  holders: ImperativeFns,
  tail: boolean,
): ImpCompiled | undefined {
  if (args.length !== 3 || (env.ruleIndex.get("if")?.length ?? 0) !== 2) return undefined;
  const addIfAbsent = compileImpAddIfAbsent(env, args, scope);
  if (addIfAbsent !== undefined) return addIfAbsent;
  const cond = compileImpAtom(env, args[0]!, scope, holders);
  const then_ = compileImpAtom(env, args[1]!, scope, holders, tail);
  const els = compileImpAtom(env, args[2]!, scope, holders, tail);
  if (cond === undefined || then_ === undefined || els === undefined) return undefined;
  return {
    node: (slots, st, ops, discard) => {
      const c = cond.node(slots, st, ops); // the condition is needed, never discarded
      if (c === BAIL) return BAIL;
      if (c.value === EMPTY_VALUE) return { value: EMPTY_VALUE, st: c.st };
      const stIf = addCounter(c.st, 2);
      if (c.value.kind !== "gnd" || c.value.value.g !== "bool") return BAIL;
      return (c.value.value.b ? then_ : els).node(slots, stIf, ops, discard);
    },
    forEach: (slots, st, ops, discard, emit) => {
      const c = cond.node(slots, st, ops); // the condition is needed, never discarded
      if (c === BAIL) return BAIL;
      if (c.value === EMPTY_VALUE) return c.st;
      const stIf = addCounter(c.st, 2);
      if (c.value.kind !== "gnd" || c.value.value.g !== "bool") return BAIL;
      return impForEach(c.value.value.b ? then_ : els, slots, stIf, ops, discard, emit);
    },
    ...impMeta([cond, then_, els]),
  };
}

function compileImpLet(
  env: MinEnv,
  args: readonly Atom[],
  scope: ImpScope,
  holders: ImperativeFns,
  tail: boolean,
): ImpCompiled | undefined {
  if (args.length !== 3 || args[0]!.kind !== "var" || (env.ruleIndex.get("let")?.length ?? 0) !== 1)
    return undefined;
  const value = compileImpAtom(env, args[1]!, scope, holders);
  if (value === undefined) return undefined;
  const slot = scope.len;
  const nextScope: ImpScope = {
    vars: new Map(scope.vars).set(args[0]!.name, slot),
    len: slot + 1,
  };
  const body = compileImpAtom(env, args[2]!, nextScope, holders, tail);
  if (body === undefined) return undefined;
  return {
    node: (slots, st, ops, discard) => {
      const v = value.node(slots, st, ops); // the bound value is read by the body, never discarded
      if (v === BAIL) return BAIL;
      // An Empty value has no results, so the let yields nothing: skip the body.
      if (v.value === EMPTY_VALUE) return { value: EMPTY_VALUE, st: v.st };
      const local = slots.slice();
      local[slot] = v.value;
      return body.node(local, addCounter(v.st, 1), ops, discard);
    },
    forEach: (slots, st, ops, discard, emit) =>
      impForEach(value, slots, st, ops, undefined, (v, stValue) => {
        const local = slots.slice();
        local[slot] = v;
        return impForEach(body, local, addCounter(stValue, 1), ops, discard, emit);
      }),
    ...impMeta([value, body]),
  };
}

function compileImpLetStar(
  env: MinEnv,
  args: readonly Atom[],
  scope: ImpScope,
  holders: ImperativeFns,
  tail: boolean,
): ImpCompiled | undefined {
  if (
    args.length !== 2 ||
    args[0]!.kind !== "expr" ||
    (env.ruleIndex.get("let*")?.length ?? 0) !== 1 ||
    (env.ruleIndex.get("let")?.length ?? 0) !== 1
  )
    return undefined;
  let curScope = scope;
  const bindings: Array<{ readonly slot: number; readonly value: ImpCompiled }> = [];
  for (const pair of args[0]!.items) {
    if (pair.kind !== "expr" || pair.items.length !== 2 || pair.items[0]!.kind !== "var")
      return undefined;
    const value = compileImpAtom(env, pair.items[1]!, curScope, holders);
    if (value === undefined) return undefined;
    const slot = curScope.len;
    bindings.push({ slot, value });
    curScope = {
      vars: new Map(curScope.vars).set(pair.items[0]!.name, slot),
      len: slot + 1,
    };
  }
  const body = compileImpAtom(env, args[1]!, curScope, holders, tail);
  if (body === undefined) return undefined;
  const parts = [...bindings.map((b) => b.value), body];
  return {
    node: (slots, st, ops, discard) => {
      const local = slots.slice();
      let cur = addCounter(st, 1);
      for (const binding of bindings) {
        const v = binding.value.node(local, cur, ops); // each bound value is read later, never discarded
        if (v === BAIL) return BAIL;
        // An Empty value has no results, so the whole let* yields nothing.
        if (v.value === EMPTY_VALUE) return { value: EMPTY_VALUE, st: v.st };
        local[binding.slot] = v.value;
        cur = addCounter(addCounter(v.st, 1), 1);
      }
      return body.node(local, cur, ops, discard);
    },
    forEach: (slots, st, ops, discard, emit) => {
      const runBinding = (i: number, local: Atom[], cur: St): St | typeof BAIL => {
        if (i === bindings.length) return impForEach(body, local, cur, ops, discard, emit);
        const binding = bindings[i]!;
        return impForEach(binding.value, local, cur, ops, undefined, (v, stValue) => {
          const next = local.slice();
          next[binding.slot] = v;
          return runBinding(i + 1, next, addCounter(addCounter(stValue, 1), 1));
        });
      };
      return runBinding(0, slots.slice(), addCounter(st, 1));
    },
    ...impMeta(parts),
  };
}

function compileImpAddAtom(
  env: MinEnv,
  args: readonly Atom[],
  scope: ImpScope,
): ImpCompiled | undefined {
  if (args.length !== 2 || args[0]!.kind !== "sym") return undefined;
  const added = args[1]!;
  if (
    added.kind !== "expr" ||
    added.items.length === 0 ||
    added.items[0]!.kind !== "sym" ||
    added.items[0]!.name === "="
  )
    return undefined;
  const space = compileImpStaticAtom(env, args[0]!, scope);
  const atom = compileImpStaticAtom(env, added, scope);
  if (space === undefined || atom === undefined) return undefined;
  return {
    node: (slots, st, ops) => {
      const s = space.node(slots, st, ops);
      if (s === BAIL) return BAIL;
      const a = atom.node(slots, s.st, ops);
      if (a === BAIL) return BAIL;
      const st2 = ops.addAtom(env, a.st, s.value, a.value);
      return st2 === undefined ? BAIL : { value: emptyExpr, st: st2 };
    },
    directEffect: true,
    callees: new Set(),
  };
}

/** Build a match pattern/template with in-scope variables substituted from slots and everything else
 *  (including free match variables like the `$t` in `(num $t)`) carried literally. Patterns are
 *  structural data by definition, so no head is denied and this always compiles. */
function compileImpPatternAtom(a: Atom, scope: ImpScope): ImpCompiled {
  if (a.kind === "var") {
    const slot = scope.vars.get(a.name);
    if (slot === undefined) return impConst(a);
    return {
      node: (slots, st) => ({ value: slots[slot]!, st }),
      directEffect: false,
      callees: new Set(),
    };
  }
  if (a.kind !== "expr" || a.items.length === 0) return impConst(a);
  return impAssembleExpr(a.items.map((it) => compileImpPatternAtom(it, scope)));
}

type ImpCaseMatchScrutinee = {
  readonly match: ExprAtom;
  readonly firstOnly: boolean;
};

function impMatchExpr(a: Atom): ExprAtom | undefined {
  return a.kind === "expr" &&
    a.items.length === 4 &&
    a.items[0]!.kind === "sym" &&
    a.items[0]!.name === "match"
    ? a
    : undefined;
}

function impCaseMatchScrutinee(scrut: Atom): ImpCaseMatchScrutinee | undefined {
  if (scrut.kind !== "expr" || scrut.items.length === 0) return undefined;
  const direct = scrut.items[0]!;
  if (direct.kind === "sym" && direct.name === "match" && scrut.items.length === 4)
    return { match: scrut, firstOnly: false };
  if (direct.kind === "sym" && direct.name === "once" && scrut.items.length === 2) {
    const match = impMatchExpr(scrut.items[1]!);
    return match === undefined ? undefined : { match, firstOnly: true };
  }
  if (direct.kind !== "sym" || direct.name !== "superpose" || scrut.items.length !== 2)
    return undefined;
  let bag = scrut.items[1]!;
  if (
    bag.kind === "expr" &&
    bag.items.length === 2 &&
    bag.items[0]!.kind === "sym" &&
    bag.items[0]!.name === "cdr-atom"
  )
    bag = bag.items[1]!;
  if (
    bag.kind !== "expr" ||
    bag.items.length !== 2 ||
    bag.items[0]!.kind !== "sym" ||
    bag.items[0]!.name !== "collapse"
  )
    return undefined;
  const match = impMatchExpr(bag.items[1]!);
  return match === undefined ? undefined : { match, firstOnly: false };
}

// `(case (match SP PAT TPL) ((V BODY)))`, `(case (once (match SP PAT TPL)) ((V BODY)))`, and the
// equivalent explicit snapshot shape `(case (superpose (cdr-atom (collapse (match SP PAT TPL)))) ((V
// BODY)))`, with a single bare-variable branch: the saturation step (peano's expand-once, matespace2's
// snapshot expand). The match solutions are a snapshot of the space at entry; each branch runs BODY with V
// bound to one solution, threading effects into the next branch, exactly the streamed case's order. A
// branch whose value is Empty is pruned; the imperative contract is single-valued, so more than one
// surviving branch BAILs (sound: worlds are immutable, so the interpreter re-runs from the untouched input
// state). The `once(match ...)` form uses the same full match counter as the interpreter, then feeds only
// the first solution to the branch.
function compileImpCaseMatch(
  env: MinEnv,
  args: readonly Atom[],
  scope: ImpScope,
  holders: ImperativeFns,
  tail: boolean,
): ImpCompiled | undefined {
  if (args.length !== 2 || (env.ruleIndex.get("case")?.length ?? 0) !== 1) return undefined;
  const scrut = impCaseMatchScrutinee(args[0]!);
  if (scrut === undefined) return undefined;
  const pairs = args[1]!;
  if (pairs.kind !== "expr" || pairs.items.length !== 1) return undefined;
  const branch = pairs.items[0]!;
  if (branch.kind !== "expr" || branch.items.length !== 2 || branch.items[0]!.kind !== "var")
    return undefined;
  const match = scrut.match;
  const space = compileImpStaticAtom(env, match.items[1]!, scope);
  if (space === undefined) return undefined;
  const pattern = compileImpPatternAtom(match.items[2]!, scope);
  const template = compileImpPatternAtom(match.items[3]!, scope);
  const slot = scope.len;
  const branchScope: ImpScope = {
    vars: new Map(scope.vars).set(branch.items[0]!.name, slot),
    len: slot + 1,
  };
  const body = compileImpAtom(env, branch.items[1]!, branchScope, holders, tail);
  if (body === undefined) return undefined;
  return {
    node: (slots, st, ops, discard) => {
      const matchSolutions = ops.matchSolutions;
      if (matchSolutions === undefined) return BAIL;
      const s = space.node(slots, st, ops);
      if (s === BAIL) return BAIL;
      const p = pattern.node(slots, s.st, ops);
      if (p === BAIL) return BAIL;
      const t = template.node(slots, p.st, ops);
      if (t === BAIL) return BAIL;
      const m = matchSolutions(env, t.st, s.value, p.value, t.value);
      if (m === undefined) return BAIL;
      let cur = addCounter(t.st, m.counterDelta);
      const local = slots.slice();
      let survived: Atom | undefined;
      const pairs = scrut.firstOnly ? m.pairs.slice(0, 1) : m.pairs;
      for (const [value] of pairs) {
        local[slot] = value;
        const r = body.node(local, cur, ops, discard);
        if (r === BAIL) return BAIL;
        cur = r.st;
        if (r.value !== EMPTY_VALUE) {
          if (survived !== undefined) return BAIL;
          survived = r.value;
        }
      }
      return { value: survived ?? EMPTY_VALUE, st: cur };
    },
    forEach: (slots, st, ops, discard, emit) => {
      const matchSolutions = ops.matchSolutions;
      if (matchSolutions === undefined) return BAIL;
      const s = space.node(slots, st, ops);
      if (s === BAIL) return BAIL;
      const p = pattern.node(slots, s.st, ops);
      if (p === BAIL) return BAIL;
      const t = template.node(slots, p.st, ops);
      if (t === BAIL) return BAIL;
      const m = matchSolutions(env, t.st, s.value, p.value, t.value);
      if (m === undefined) return BAIL;
      let cur = addCounter(t.st, m.counterDelta);
      const local = slots.slice();
      const pairs = scrut.firstOnly ? m.pairs.slice(0, 1) : m.pairs;
      for (const [value] of pairs) {
        local[slot] = value;
        const next = impForEach(body, local, cur, ops, discard, emit);
        if (next === BAIL) return BAIL;
        cur = next;
      }
      return cur;
    },
    directEffect: true,
    callees: body.callees,
  };
}

function compileImpCall(
  env: MinEnv,
  op: string,
  args: readonly Atom[],
  scope: ImpScope,
  holders: ImperativeFns,
  tail: boolean,
): ImpCompiled | undefined {
  const h = holders.get(op);
  if (h === undefined || args.length !== h.arity) return undefined;
  const compiledArgs = args.map((arg) => compileImpAtom(env, arg, scope, holders));
  if (compiledArgs.some((arg) => arg === undefined)) return undefined;
  const parts = compiledArgs as ImpCompiled[];
  const meta = impMeta(parts);
  const runNested = <T>(
    runtimeOps: CompiledImpureOps,
    callArgs: readonly Atom[],
    callState: St,
    run: () => T,
  ): T => {
    const evaluationDepth = runtimeOps.evaluationDepth;
    if (evaluationDepth === undefined || tail) return run();
    const boundary = evaluationDepth.enterBoundary(
      runtimeOps.maxStackDepth ?? 0,
      EVALUATION_TRAMPOLINE_DEPTH,
    );
    if (boundary !== undefined)
      throwEvaluationDepthBoundary(boundary, expr([sym(op), ...callArgs]), callState);
    try {
      return run();
    } finally {
      evaluationDepth.leave();
    }
  };
  return {
    node: (slots, st, ops, discard) => {
      const r = impEvalArgs(parts, slots, st, ops); // call args are needed, never discarded
      if (r === BAIL) return BAIL;
      // An Empty argument makes the call empty without invoking it (args already ran for effects).
      if (r.empty) return { value: EMPTY_VALUE, st: r.st };
      return runNested(ops, r.vals, r.st, () => h.run(r.vals, r.st, ops, discard));
    },
    forEach: (slots, st, ops, discard, emit) => {
      const r = impEvalArgs(parts, slots, st, ops); // call args are needed, never discarded
      if (r === BAIL) return BAIL;
      if (r.empty) return r.st;
      if (h.runForEach !== undefined)
        return runNested(ops, r.vals, r.st, () => h.runForEach!(r.vals, r.st, ops, discard, emit));
      const v = runNested(ops, r.vals, r.st, () => h.run(r.vals, r.st, ops, discard));
      if (v === BAIL) return BAIL;
      return v.value === EMPTY_VALUE ? v.st : emit(v.value, v.st);
    },
    directEffect: meta.directEffect,
    callees: new Set([...meta.callees, op]),
  };
}

function compileImpTuple(
  env: MinEnv,
  items: readonly Atom[],
  scope: ImpScope,
  holders: ImperativeFns,
): ImpCompiled | undefined {
  const parts = items.map((it) => compileImpAtom(env, it, scope, holders));
  if (parts.some((part) => part === undefined)) return undefined;
  const compiled = parts as ImpCompiled[];
  const node: ImpNode = (slots, st, ops, discard) => {
    let cur = st;
    if (discard === true) {
      // The result is thrown away (a dead let binding the build never reads). Run each element for its
      // effects, forwarding discard, so a deeply recursive tuple build (matespace's rewriteK) runs all its
      // add-atoms without ever allocating the result tree. Empty still prunes the tuple, because the binding
      // value is dead but the binding branch is not.
      let empty = false;
      for (const part of compiled) {
        const r = part.node(slots, cur, ops, true);
        if (r === BAIL) return BAIL;
        if (r.value === EMPTY_VALUE) empty = true;
        cur = r.st;
      }
      if (empty) return { value: EMPTY_VALUE, st: cur };
      return { value: emptyExpr, st: cur };
    }
    const out: Atom[] = [];
    let empty = false;
    for (const part of compiled) {
      const r = part.node(slots, cur, ops);
      if (r === BAIL) return BAIL;
      if (r.value === EMPTY_VALUE) empty = true;
      out.push(r.value);
      cur = r.st;
    }
    // An Empty element makes the whole tuple empty (the cross-product with nothing); the other
    // elements still ran for their effects.
    if (empty) return { value: EMPTY_VALUE, st: cur };
    return { value: expr(out), st: cur };
  };
  return {
    node,
    forEach: (slots, st, ops, discard, emit) => {
      const r = node(slots, st, ops, discard);
      if (r === BAIL) return BAIL;
      return r.value === EMPTY_VALUE ? r.st : emit(r.value, r.st);
    },
    ...impMeta(compiled),
  };
}

function compileImpAtom(
  env: MinEnv,
  a: Atom,
  scope: ImpScope,
  holders: ImperativeFns,
  tail = false,
): ImpCompiled | undefined {
  if (a.kind !== "expr" || a.items.length === 0) return compileImpStaticAtom(env, a, scope);
  const head = a.items[0]!;
  if (head.kind !== "sym") {
    // A variable head can bind at runtime to a function symbol, so `($f $x)` is a reducible higher-order
    // application, not inert data. The imperative VM would freeze it as a tuple and the dispatch skips
    // re-reducing a compiled impure result, so it would never reduce (e.g. `(doit foo 3)` -> `(foo 3)`
    // instead of `(R 3)`). PeTTa emits a runtime dispatch for a var head (translator.pl: "Unknown head
    // (var/compound) => runtime dispatch"); we bail so the interpreter dispatches it. A compound (expr) head
    // is a tuple whose head is itself an evaluated call to a data-returning function (matespace's rewriteK),
    // which stays compilable.
    if (head.kind === "var") return undefined;
    return compileImpTuple(env, a.items, scope, holders);
  }
  const op = head.name;
  const args = a.items.slice(1);
  if (op === "if") return compileImpIf(env, args, scope, holders, tail);
  if (op === "let") return compileImpLet(env, args, scope, holders, tail);
  if (op === "let*") return compileImpLetStar(env, args, scope, holders, tail);
  if (op === "add-atom") return compileImpAddAtom(env, args, scope);
  if (op === "case") return compileImpCaseMatch(env, args, scope, holders, tail);
  if (IMP_GROUNDED.has(op)) return compileImpGrounded(env, op, args, scope, holders);
  const call = compileImpCall(env, op, args, scope, holders, tail);
  if (call !== undefined) return call;
  return compileImpStaticAtom(env, a, scope);
}

function buildImpScope(params: readonly ParamPat[]): ImpScope | undefined {
  const vars = new Map<string, number>();
  for (let i = 0; i < params.length; i++) {
    const p = params[i]!;
    if (typeof p !== "string") return undefined;
    vars.set(p, i);
  }
  return { vars, len: params.length };
}

function compileImperative(env: MinEnv, compiled: CompiledFns): void {
  if (env.varRulesVar.length !== 0) return;
  const cand: Cand = new Map();
  for (const f of env.ruleIndex.keys()) {
    if (compiled.has(f)) continue;
    const h = singleClauseHead(env, f);
    if (h !== undefined && h.params.every((p) => typeof p === "string")) cand.set(f, h);
  }
  const holders: ImperativeFns = new Map();
  for (const [f, { params }] of cand)
    holders.set(f, { kind: "imperative", arity: params.length, clauseCount: 1, run: impBail });

  for (;;) {
    let removed = false;
    const bodies = new Map<string, ImpCompiled>();
    for (const [f, h] of [...holders]) {
      const cd = cand.get(f)!;
      const scope = buildImpScope(cd.params);
      const body =
        scope === undefined ? undefined : compileImpAtom(env, cd.body, scope, holders, true);
      if (body === undefined) {
        holders.delete(f);
        removed = true;
      } else {
        bodies.set(f, body);
        h.arity = cd.params.length;
      }
    }
    if (removed) continue;

    const effectful = new Set<string>();
    for (const [f, body] of bodies) if (body.directEffect) effectful.add(f);
    for (let changed = true; changed; ) {
      changed = false;
      for (const [f, body] of bodies) {
        if (effectful.has(f)) continue;
        for (const callee of body.callees)
          if (effectful.has(callee)) {
            effectful.add(f);
            changed = true;
            break;
          }
      }
    }
    for (const f of [...holders.keys()])
      if (!effectful.has(f)) {
        holders.delete(f);
        removed = true;
      }
    if (removed) continue;

    for (const [f, body] of bodies) {
      const arity = cand.get(f)!.params.length;
      holders.get(f)!.run = (partAtoms, st, ops, discard) => {
        if (partAtoms.length !== arity || partAtoms.some((a) => !a.ground)) return BAIL;
        // A self-call recurses natively (compileImpCall -> h.run -> body.node), so deep recursion grows the
        // host stack exactly as the interpreter's does. A native stack overflow must PROPAGATE to the
        // top-level `mettaEval` catch, which turns it into `(Error <query> StackOverflow)` — byte-identical
        // to the interpreter overflowing on the same call. Returning BAIL on a RangeError instead would fall
        // back to the interpreter, which re-reduces one level and re-enters the compiled function for the
        // rest, overflowing again: O(depth^2) bail+overflow that lets a StackOverflow escape. So catch only a
        // thrown BAIL sentinel and let everything else (RangeError included) unwind.
        try {
          return body.node(partAtoms, addCounter(st, 1), ops, discard);
        } catch (e) {
          if (e === BAIL) return BAIL;
          throw e;
        }
      };
      holders.get(f)!.runForEach = (partAtoms, st, ops, discard, emit) => {
        if (partAtoms.length !== arity || partAtoms.some((a) => !a.ground)) return BAIL;
        try {
          return impForEach(body, partAtoms, addCounter(st, 1), ops, discard, emit);
        } catch (e) {
          if (e === BAIL) return BAIL;
          throw e;
        }
      };
    }
    for (const [f, h] of holders) compiled.set(f, h);
    return;
  }
}

/** Compile every compilable pure single-clause function in `env` to a memoised native closure.
 *  Phase 1 infers return types (fixpoint, optimistic over recursion). Phase 2 compiles bodies with
 *  those types and drops any that fail end-to-end (a call to an uncompilable function fails too). */
export function compileEnv(env: MinEnv): CompiledFns {
  const pure = env.pureFunctors ?? new Set<string>();
  const cand: Cand = new Map();
  for (const f of pure) {
    const h = singleClauseHead(env, f);
    if (h !== undefined) cand.set(f, h);
  }

  // A holder per candidate, types refined below. retType starts undefined (a sentinel that inferType reads
  // back as "not yet known"); the fixpoint refines both each plain-var parameter's type (from how it is used
  // as a tuple argument) and the return type, since either may depend on the other and on callees.
  const holders: FunctionalFns = new Map();
  for (const [f, { params }] of cand)
    holders.set(f, {
      kind: "functional",
      name: f,
      arity: params.length,
      retType: undefined as unknown as Ty,
      paramTypes: paramTypesOf(params),
      run: bailRun,
    });
  for (let changed = true; changed; ) {
    changed = false;
    for (const [f, { params, body }] of cand) {
      const h = holders.get(f)!;
      params.forEach((p, i) => {
        if (typeof p === "string" && h.paramTypes[i] === "int") {
          const t = inferVarType(body, p, holders);
          if (t !== undefined && t !== "int") {
            h.paramTypes[i] = t;
            changed = true;
          }
        }
      });
      if ((h.retType as Ty | undefined) === undefined) {
        const rt = inferType(body, varTypesOf(params, h.paramTypes), holders);
        if (rt !== undefined) {
          h.retType = rt;
          changed = true;
        }
      }
    }
  }
  for (const [f, h] of [...holders])
    if ((h.retType as Ty | undefined) === undefined) holders.delete(f);

  for (;;) {
    let removed = false;
    const result = new Map<string, { node: Node; arity: number }>();
    for (const [f] of [...holders]) {
      const cd = cand.get(f)!;
      const c = compileTail(cd.body, buildScope(cd.params, holders.get(f)!.paramTypes), holders, f);
      if (c === undefined) {
        holders.delete(f);
        removed = true;
      } else {
        result.set(f, { node: c.node, arity: cd.params.length });
      }
    }
    if (!removed) {
      for (const [f, { node, arity }] of result)
        holders.get(f)!.run = makeRun(f, arity, node, selfCallCount(cand.get(f)!.body, f) >= 2);
      const compiled: CompiledFns = new Map(holders);
      for (const [f, h] of compileScalarHolders(env, pure, holders)) compiled.set(f, h);
      for (const f of pure) {
        if (compiled.has(f)) continue;
        const rewrite = compileRewrite(env, f);
        if (rewrite !== undefined) {
          compiled.set(f, rewrite);
          continue;
        }
        const symbolic = compileSymbolic(env, f);
        if (symbolic !== undefined) compiled.set(f, symbolic);
      }
      for (const f of env.ruleIndex.keys()) {
        if (compiled.has(f)) continue;
        const choiceUnion = compileChoiceUnion(env, f);
        if (choiceUnion !== undefined) compiled.set(f, choiceUnion);
      }
      for (const f of env.ruleIndex.keys()) {
        if (compiled.has(f)) continue;
        const pipeline = compileSynthesisPipeline(env, f, compiled);
        if (pipeline !== undefined) compiled.set(f, pipeline);
      }
      compileImperative(env, compiled);
      // Nondeterministic searching functors: let*-chain match functors and the mutually-recursive
      // proof-size-bounded chainers. A functor pulls its call-graph closure into one group holder, so
      // register every functor the group compiled.
      for (const f of env.ruleIndex.keys()) {
        if (compiled.has(f)) continue;
        const group = compileNondetGroup(env, f);
        if (group !== undefined) for (const [g, h] of group) compiled.set(g, h);
      }
      return compiled;
    }
  }
}

/** Run a compiled function, returning an ordered result bag, or `undefined` to fall back to the interpreter
 *  when the call falls outside the proven subset. */
export function runCompiled(
  env: MinEnv,
  op: string,
  partAtoms: readonly Atom[],
  st: St,
  ops?: CompiledImpureOps,
  discard?: boolean,
  fuel?: number,
  depth?: EvaluationDepth,
): CompiledRunResult | undefined {
  const h = env.compiled?.get(op);
  if (h === undefined || partAtoms.length !== h.arity) return undefined;
  if (
    depth !== undefined &&
    depth.current >= EVALUATION_TRAMPOLINE_DEPTH &&
    (h.kind === "functional" ||
      h.kind === "scalar" ||
      h.kind === "imperative" ||
      (h.kind === "nondet" && !h.preferDirectForModed))
  )
    return undefined;
  const runtimeOps =
    ops === undefined || depth === undefined
      ? ops
      : { ...ops, evaluationDepth: depth, maxStackDepth: st.world.maxStackDepth };
  const overflowResult = (error: EvaluationDepthOverflow, counterDelta = 0): CompiledRunResult => {
    const overflowState = error.state as St | undefined;
    return {
      results: [
        {
          atom: expr([sym("Error"), error.atom, sym("StackOverflow")]),
          bnd: emptyBindings,
        },
      ],
      counterDelta,
      ...(overflowState === undefined ? {} : { state: overflowState }),
    };
  };
  const runValue = (holder: ValueHolder, vals: FrameVal[]): CompiledRunResult | undefined => {
    const runtime = {
      depth: depth ?? new EvaluationDepth(),
      limit: depth === undefined ? 0 : st.world.maxStackDepth,
      counterBase: st.counter,
      counterLimit:
        st.world.maxSteps > 0 ? st.world.stepStart + st.world.maxSteps - st.counter : undefined,
      counterDelta: 0,
      freshSuffix: "",
    };
    try {
      const r = holder.run(vals, runtime, true);
      const atom = frameValueToAtom(r);
      return {
        results: [{ atom, bnd: emptyBindings }],
        counterDelta: holder.kind === "scalar" ? runtime.counterDelta : 0,
      };
    } catch (e) {
      if (e instanceof EvaluationDepthHandoff) return undefined;
      if (e instanceof EvaluationDepthOverflow) return overflowResult(e, runtime.counterDelta);
      if (e === BAIL || e instanceof RangeError) return undefined;
      throw e;
    }
  };
  if (h.kind === "scalar") {
    if (partAtoms.some((atom) => !atom.ground)) return undefined;
    return runValue(h, partAtoms as FrameVal[]);
  }
  if (h.kind === "rewrite") return h.run(partAtoms);
  if (h.kind === "symbolic") return h.run(partAtoms, st.counter);
  if (h.kind === "nondet") {
    if (runtimeOps === undefined) return undefined;
    try {
      return h.run(env, partAtoms, st, runtimeOps, fuel);
    } catch (error) {
      if (error instanceof EvaluationDepthHandoff) return undefined;
      if (error instanceof EvaluationDepthOverflow) return overflowResult(error);
      throw error;
    }
  }
  if (h.kind === "imperative") {
    if (runtimeOps === undefined) return undefined;
    let r: ImpEval;
    try {
      r = h.run(partAtoms, st, runtimeOps, discard);
    } catch (error) {
      if (error instanceof EvaluationDepthHandoff) return undefined;
      if (error instanceof EvaluationDepthOverflow) return overflowResult(error);
      throw error;
    }
    if (r === BAIL) return undefined;
    // An Empty value is a pruned computation: the call vanishes (zero results), effects kept.
    if (r.value === EMPTY_VALUE) return { results: [], counterDelta: 0, state: r.st };
    return { results: [{ atom: r.value, bnd: emptyBindings }], counterDelta: 0, state: r.st };
  }
  // An argument is a ground int, or a flat tuple of ground ints `(i1 i2 ...)` (the iterate/quad-step state).
  const vals: FrameVal[] = [];
  for (const a of partAtoms) {
    if (a.kind === "gnd" && a.value.g === "int") vals.push(a.value.n);
    else if (
      a.kind === "expr" &&
      a.items.length > 0 &&
      a.items.every((x) => x.kind === "gnd" && x.value.g === "int")
    )
      vals.push(new Tup(a.items.map((x) => (x as { value: { n: IntVal } }).value.n)));
    else return undefined;
  }
  return runValue(h, vals);
}

export function runCompiledEffectCount(
  env: MinEnv,
  op: string,
  partAtoms: readonly Atom[],
  st: St,
  ops: CompiledImpureOps,
  depth?: EvaluationDepth,
): { readonly count: number; readonly state: St } | undefined {
  const h = env.compiled?.get(op);
  if (h === undefined || h.kind !== "imperative" || partAtoms.length !== h.arity) return undefined;
  const runForEach = h.runForEach;
  if (runForEach === undefined) return undefined;
  const runtimeOps =
    depth === undefined
      ? ops
      : { ...ops, evaluationDepth: depth, maxStackDepth: st.world.maxStackDepth };
  let count = 0;
  let state: St | typeof BAIL;
  try {
    state = runForEach(partAtoms, st, runtimeOps, true, (_value, stValue) => {
      count += 1;
      return stValue;
    });
  } catch (e) {
    if (
      e === BAIL ||
      e instanceof RangeError ||
      e instanceof EvaluationDepthHandoff ||
      e instanceof EvaluationDepthOverflow
    )
      return undefined;
    throw e;
  }
  return state === BAIL ? undefined : { count, state };
}
