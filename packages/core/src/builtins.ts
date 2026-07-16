// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

import { alphaEq } from "./alpha";
// The grounding table: built-in operations dispatched by symbol name, a faithful port of
// LeaTTa `Core/Builtins.lean`. Each op takes already-evaluated argument atoms and returns a
// ReduceResult. Numbers track int vs float; arithmetic on two ints stays int.
import {
  type Atom,
  type Ground,
  atomEq,
  atomVars,
  emptyExpr,
  expr,
  gbool,
  gfloat,
  gint,
  gnd,
  gstr,
  isErrorAtom,
  sym,
  variable,
} from "./atom";
import { dedupAlphaStable } from "./atom-set";
import { matchAtoms } from "./match";
import {
  addInt,
  type IntVal,
  intAbs,
  intDiv,
  intMod,
  isZero,
  mulInt,
  subInt,
  toF64,
} from "./number";
import { format, parseAll } from "./parser";
import { applySubst, type Subst } from "./substitution";
import { Tokenizer } from "./tokenizer";
import { readonlyMapSnapshot, readonlySetSnapshot } from "./readonly-collection";

// A standalone tokenizer for `parse`/`sread` (number/bool literals), built here to avoid importing the runner
// (which imports this module). Matches the runner's standardTokenizer.
let parseTokenizer: Tokenizer | undefined;
function makeTokenizer(): Tokenizer {
  if (parseTokenizer === undefined) {
    const t = new Tokenizer();
    t.register(/^[+-]?\d+$/, (s) => gint(BigInt(s)));
    t.register(/^[+-]?\d+\.\d+$/, (s) => gfloat(Number(s)));
    t.register(/^[+-]?\d+(\.\d+)?[eE][-+]?\d+$/, (s) => gfloat(Number(s)));
    t.register(/^True$/, () => gbool(true));
    t.register(/^False$/, () => gbool(false));
    parseTokenizer = t;
  }
  return parseTokenizer;
}

export type ReduceEffect =
  | { readonly kind: "addAtom"; readonly space: Atom; readonly atom: Atom }
  | { readonly kind: "removeAtom"; readonly space: Atom; readonly atom: Atom }
  | { readonly kind: "bindToken"; readonly name: string; readonly atom: Atom };

export type ReduceResult =
  | {
      readonly tag: "ok";
      readonly results: readonly Atom[];
      readonly effects?: readonly ReduceEffect[];
    }
  | { readonly tag: "runtimeError"; readonly msg: string }
  | { readonly tag: "incorrectArgument"; readonly msg: string }
  | { readonly tag: "noReduce" };

export interface GroundedTypeEnvironment {
  readonly signatures: ReadonlyMap<string, readonly Atom[]>;
  readonly declaredTypes: ReadonlyMap<string, readonly Atom[]>;
  readonly expressionTypes: readonly (readonly [Atom, Atom])[];
}

export interface GroundedOperationEnvironment {
  readonly synchronous: ReadonlySet<string>;
  readonly asynchronous: ReadonlySet<string>;
}

export interface GroundedWorldAtomDelta {
  readonly space: Atom;
  readonly atom: Atom;
}

export interface GroundedWorldTokenDelta {
  readonly name: string;
  readonly atom: Atom;
}

export interface GroundedImportWorldDelta {
  readonly addedAtoms: readonly GroundedWorldAtomDelta[];
  readonly removedAtoms: readonly GroundedWorldAtomDelta[];
  readonly boundTokens: readonly GroundedWorldTokenDelta[];
}

export interface GroundedModuleInstallation {
  readonly request: Atom;
  readonly resolvedIdentity?: string;
  readonly source: "catalog" | "host";
  readonly contentHash?: string;
  readonly targetSpace: Atom;
  readonly previousGeneration: number;
  readonly generation: number;
  readonly worldDelta: GroundedImportWorldDelta;
}

/** Dynamic interpreter context supplied to sync, async, and import groundeds. */
export interface GroundedCallContext {
  readonly currentSpace: Atom;
  readonly visibleSpaces: readonly Atom[];
  readonly expectedType: Atom;
  /** Logical-update generation of the branch world observed by this call. */
  readonly generation?: number;
  readonly typeEnvironment?: GroundedTypeEnvironment;
  readonly groundingEnvironment?: GroundedOperationEnvironment;
  readonly imports?: ReadonlyMap<string, readonly Atom[]>;
  /** Append-only successful import history. Removing imported atoms does not erase this audit log. */
  readonly moduleInstallations?: readonly GroundedModuleInstallation[];
  readonly capabilities?: ReadonlySet<string>;
}

export const DEFAULT_GROUNDED_CALL_CONTEXT: GroundedCallContext = Object.freeze({
  currentSpace: sym("&self"),
  visibleSpaces: Object.freeze([sym("&self")]),
  expectedType: sym("%Undefined%"),
  generation: 0,
  typeEnvironment: Object.freeze({
    signatures: readonlyMapSnapshot(new Map<string, readonly Atom[]>()),
    declaredTypes: readonlyMapSnapshot(new Map<string, readonly Atom[]>()),
    expressionTypes: Object.freeze([] as Array<readonly [Atom, Atom]>),
  }),
  groundingEnvironment: Object.freeze({
    synchronous: readonlySetSnapshot(new Set<string>()),
    asynchronous: readonlySetSnapshot(new Set<string>()),
  }),
  imports: readonlyMapSnapshot(new Map<string, readonly Atom[]>()),
  moduleInstallations: Object.freeze([] as GroundedModuleInstallation[]),
  capabilities: readonlySetSnapshot(new Set<string>()),
});

export type GroundFn = (args: readonly Atom[], context?: GroundedCallContext) => ReduceResult;
export type GroundingTable = Map<string, GroundFn>;

const groundedOperationTypes = new WeakMap<GroundFn, Atom>();

function withGroundedOperationType(op: GroundFn, type: Atom): GroundFn {
  groundedOperationTypes.set(op, type);
  return op;
}

/** Return the type carried by a grounded operation, if it has one. */
export function groundedOperationType(op: GroundFn): Atom | undefined {
  return groundedOperationTypes.get(op);
}

// Monotonic counter for `sealed`'s fresh variable names (process-wide uniqueness, like Hyperon's make_unique).
let sealCounter = 0;
const ok = (...results: Atom[]): ReduceResult => ({ tag: "ok", results });
const rerr = (msg: string): ReduceResult => ({ tag: "runtimeError", msg });
const ierr = (msg: string): ReduceResult => ({ tag: "incorrectArgument", msg });
const nored = (): ReduceResult => ({ tag: "noReduce" });

// Line sink for println!/trace!: console.log is the natural equivalent (it appends the newline).
// Overridable so embedders and tests can capture output instead of writing to the console.
let outputSink: (line: string) => void = (line) => {
  console.log(line);
};
/** Replace the line-output sink used by `println!`/`trace!` (returns the previous sink). */
export function setOutputSink(fn: (line: string) => void): (line: string) => void {
  const prev = outputSink;
  outputSink = fn;
  return prev;
}

// Raw sink for print!, which (per Hyperon) writes WITHOUT a trailing newline. In Node that is
// process.stdout.write; the browser has no partial-line console, so it falls back to console.log (one line).
let rawSink: (text: string) => void =
  typeof process !== "undefined" && process.stdout && typeof process.stdout.write === "function"
    ? (text) => void process.stdout.write(text)
    : (text) => console.log(text);
/** Replace the raw (no-newline) sink used by `print!` (returns the previous sink). */
export function setRawSink(fn: (text: string) => void): (text: string) => void {
  const prev = rawSink;
  rawSink = fn;
  return prev;
}

/** Display form of an atom for printing: a top-level string shows unquoted; everything else uses the
 *  standard MeTTa rendering. */
function display(a: Atom): string {
  if (a.kind === "gnd" && a.value.g === "str") return a.value.s;
  return format(a);
}

// --- numeric coercions ---
/** The integer value of an atom (number|bigint), or undefined if not an Int. */
function asIntVal(a: Atom): IntVal | undefined {
  return a.kind === "gnd" && a.value.g === "int" ? a.value.n : undefined;
}
function asBool(a: Atom): boolean | undefined {
  if (a.kind === "gnd" && a.value.g === "bool") return a.value.b;
  return undefined;
}
function asStr(a: Atom): string | undefined {
  return a.kind === "gnd" && a.value.g === "str" ? a.value.s : undefined;
}
/** The f64 value of an Int or Float atom (Int is coerced, with the usual precision caveat). */
function asFloat(a: Atom): number | undefined {
  if (a.kind !== "gnd") return undefined;
  const v = a.value;
  if (v.g === "int") return toF64(v.n);
  if (v.g === "float") return v.n;
  return undefined;
}
function asByteOffset(a: Atom): number | undefined {
  const n = asFloat(a);
  return n !== undefined && Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

interface HostFs {
  readonly constants: {
    readonly O_RDONLY: number;
    readonly O_WRONLY: number;
    readonly O_RDWR: number;
    readonly O_CREAT: number;
    readonly O_APPEND: number;
    readonly O_TRUNC: number;
  };
  openSync(path: string, flags: number, mode?: number): number;
  readSync(
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): number;
  writeSync(
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): number;
  fstatSync(fd: number): { readonly size: number | bigint };
  closeSync(fd: number): void;
}

interface HostGitFs {
  existsSync(path: string): boolean;
  mkdirSync(path: string, options?: { readonly recursive?: boolean }): unknown;
  statSync(path: string): { isDirectory(): boolean };
}

interface HostChildProcess {
  execFileSync(
    file: string,
    args: readonly string[],
    options?: { readonly stdio?: "pipe" | "ignore" | "inherit" },
  ): unknown;
}

interface HostGit {
  readonly fs: HostGitFs;
  readonly childProcess: HostChildProcess;
}

let hostFsChecked = false;
let hostFs: HostFs | undefined;
let hostGitChecked = false;
let hostGit: HostGit | undefined;
let hostEffectsEnabled = true;

/** Enable or disable host effects such as file IO and git imports for this process. */
export function setHostEffectsEnabled(enabled: boolean): void {
  hostEffectsEnabled = enabled;
}

function isHostFs(value: unknown): value is HostFs {
  const fs = value as Partial<HostFs> | undefined;
  return (
    fs !== undefined &&
    typeof fs.openSync === "function" &&
    typeof fs.readSync === "function" &&
    typeof fs.writeSync === "function" &&
    typeof fs.fstatSync === "function" &&
    typeof fs.closeSync === "function" &&
    fs.constants !== undefined
  );
}

function isHostGitFs(value: unknown): value is HostGitFs {
  const fs = value as Partial<HostGitFs> | undefined;
  return (
    fs !== undefined &&
    typeof fs.existsSync === "function" &&
    typeof fs.mkdirSync === "function" &&
    typeof fs.statSync === "function"
  );
}

function isHostChildProcess(value: unknown): value is HostChildProcess {
  const childProcess = value as Partial<HostChildProcess> | undefined;
  return childProcess !== undefined && typeof childProcess.execFileSync === "function";
}

function getHostFs(): HostFs | undefined {
  if (!hostEffectsEnabled) return undefined;
  if (hostFsChecked) return hostFs;
  hostFsChecked = true;
  try {
    const proc = (
      globalThis as {
        readonly process?: {
          readonly getBuiltinModule?: (name: string) => unknown;
        };
      }
    ).process;
    const fs = proc?.getBuiltinModule?.("node:fs") ?? proc?.getBuiltinModule?.("fs");
    if (isHostFs(fs)) hostFs = fs;
  } catch {
    // Browser and sandboxed hosts fall through to the explicit Error atom path.
  }
  if (hostFs !== undefined) return hostFs;
  try {
    const req = (0, eval)("typeof require === 'function' ? require : undefined") as
      | ((moduleName: string) => unknown)
      | undefined;
    const fs = req?.("node:fs");
    if (isHostFs(fs)) hostFs = fs;
  } catch {
    // Browser and sandboxed hosts fall through to the explicit Error atom path.
  }
  return hostFs;
}

function getHostGit(): HostGit | undefined {
  if (!hostEffectsEnabled) return undefined;
  if (hostGitChecked) return hostGit;
  hostGitChecked = true;
  try {
    const proc = (
      globalThis as {
        readonly process?: {
          readonly getBuiltinModule?: (name: string) => unknown;
        };
      }
    ).process;
    const fs = proc?.getBuiltinModule?.("node:fs") ?? proc?.getBuiltinModule?.("fs");
    const childProcess =
      proc?.getBuiltinModule?.("node:child_process") ?? proc?.getBuiltinModule?.("child_process");
    if (isHostGitFs(fs) && isHostChildProcess(childProcess)) hostGit = { fs, childProcess };
  } catch {
    // Browser and sandboxed hosts fall through to the explicit Error atom path.
  }
  if (hostGit !== undefined) return hostGit;
  try {
    const req = (0, eval)("typeof require === 'function' ? require : undefined") as
      | ((moduleName: string) => unknown)
      | undefined;
    const fs = req?.("node:fs");
    const childProcess = req?.("node:child_process");
    if (isHostGitFs(fs) && isHostChildProcess(childProcess)) hostGit = { fs, childProcess };
  } catch {
    // Browser and sandboxed hosts fall through to the explicit Error atom path.
  }
  return hostGit;
}

/** Binary arithmetic: two Ints use exact integer math (bigint on overflow); a Float on either side
 *  promotes both to f64. Mirrors Hyperon's int-stays-int, int+float->float rule. */
function arithBin(
  intF: (x: IntVal, y: IntVal) => IntVal,
  floatF: (x: number, y: number) => number,
): GroundFn {
  return (args) => {
    if (args.length !== 2) return ierr("expected exactly two arguments");
    const ax = asIntVal(args[0]!);
    const ay = asIntVal(args[1]!);
    if (ax !== undefined && ay !== undefined) return ok(gint(intF(ax, ay)));
    const fx = asFloat(args[0]!);
    const fy = asFloat(args[1]!);
    if (fx === undefined || fy === undefined) return nored();
    return ok(gfloat(floatF(fx, fy)));
  };
}

/** Three-way compare: exact for two Ints (promoting to bigint as needed), f64 otherwise. */
function compareNumbers(a: Atom, b: Atom): number | undefined {
  const ai = asIntVal(a);
  const bi = asIntVal(b);
  if (ai !== undefined && bi !== undefined) {
    if (typeof ai === "bigint" || typeof bi === "bigint") {
      const x = BigInt(ai);
      const y = BigInt(bi);
      return x < y ? -1 : x > y ? 1 : 0;
    }
    return ai < bi ? -1 : ai > bi ? 1 : 0;
  }
  const af = asFloat(a);
  const bf = asFloat(b);
  if (af === undefined || bf === undefined) return undefined;
  if (Number.isNaN(af) || Number.isNaN(bf)) return Number.NaN;
  return af < bf ? -1 : af > bf ? 1 : 0;
}
function numCmp(f: (c: number) => boolean): GroundFn {
  return (args) => {
    if (args.length !== 2) return ierr("expected exactly two arguments");
    const c = compareNumbers(args[0]!, args[1]!);
    if (c === undefined) return nored();
    return ok(gbool(f(c)));
  };
}
function boolBin(f: (x: boolean, y: boolean) => boolean): GroundFn {
  return (args) => {
    if (args.length !== 2) return ierr("expected exactly two arguments");
    const x = asBool(args[0]!);
    const y = asBool(args[1]!);
    if (x === undefined || y === undefined) return ierr("expected two Bool atoms");
    return ok(gbool(f(x, y)));
  };
}

// Equality operators pass through error operands and compare every other atom structurally.
function equalityCmp(expectEqual: boolean): GroundFn {
  return (args) => {
    if (args.length !== 2) return ierr("expected exactly two arguments");
    const a = args[0]!;
    const b = args[1]!;
    if (isErrorAtom(a)) return ok(a);
    if (isErrorAtom(b)) return ok(b);
    return ok(gbool(atomEq(a, b) === expectEqual));
  };
}
const eqAtom = equalityCmp(true);
// Hyperon carries operation types on grounded values instead of inserting declarations into &self.
const neqAtom = withGroundedOperationType(
  equalityCmp(false),
  expr([sym("->"), variable("t"), variable("t"), sym("Bool")]),
);

// --- list surgery ---
const consAtom: GroundFn = (args) => {
  if (args.length !== 2) return ierr("expected head and tail");
  const [h, t] = args as [Atom, Atom];
  if (t.kind !== "expr") return ierr("cons-atom: expected an expression tail");
  return ok(expr([h, ...t.items]));
};
const deconsAtom: GroundFn = (args) => {
  if (args.length !== 1) return ierr("expected non-empty expression");
  const e = args[0]!;
  if (e.kind !== "expr") return ierr("expected non-empty expression");
  if (e.items.length === 0) return ierr("expected non-empty expression");
  const [h, ...t] = e.items;
  return ok(expr([h!, expr(t)]));
};
const carAtom: GroundFn = (args) => {
  const e = args[0];
  if (args.length !== 1 || e?.kind !== "expr" || e.items.length === 0)
    return ierr("car-atom expects a non-empty expression as an argument");
  return ok(e.items[0]!);
};
const cdrAtom: GroundFn = (args) => {
  const e = args[0];
  if (args.length !== 1 || e?.kind !== "expr" || e.items.length === 0)
    return ierr("expected non-empty expression");
  return ok(expr(e.items.slice(1)));
};
const sizeAtom: GroundFn = (args) => {
  if (args.length !== 1) return ierr("size-atom expects one expression");
  const a = args[0]!;
  if (a.kind !== "expr") return ierr("size-atom expects one expression");
  return ok(gint(a.items.length));
};
const minMaxAtom =
  (isMin: boolean, name: string): GroundFn =>
  (args) => {
    const e = args[0];
    if (args.length !== 1 || e?.kind !== "expr")
      return ierr(name + " expects one argument: expression");
    const nums: number[] = [];
    for (const c of e.items) {
      const f = asFloat(c);
      if (f === undefined) return rerr("Only numbers are allowed in expression");
      nums.push(f);
    }
    if (nums.length === 0) return rerr("Empty expression");
    let acc = nums[0]!;
    for (const z of nums.slice(1)) acc = isMin ? (z < acc ? z : acc) : z > acc ? z : acc;
    return ok(gfloat(acc));
  };
const indexAtom: GroundFn = (args) => {
  const e = args[0];
  if (args.length !== 2 || e?.kind !== "expr")
    return ierr("index-atom expects two arguments: expression and atom");
  const iv = asIntVal(args[1]!);
  if (iv === undefined) return ierr("index-atom expects two arguments: expression and atom");
  const i = Number(iv);
  if (i < 0 || i >= e.items.length) return rerr("Index is out of bounds");
  return ok(e.items[i]!);
};

// --- f64 math ---
const floatUn =
  (ff: (x: number) => number): GroundFn =>
  (args) => {
    if (args.length !== 1) return ierr("expected exactly one argument");
    const x = asFloat(args[0]!);
    return x === undefined ? nored() : ok(gfloat(ff(x)));
  };
const floatBin =
  (ff: (x: number, y: number) => number): GroundFn =>
  (args) => {
    if (args.length !== 2) return ierr("expected exactly two arguments");
    const x = asFloat(args[0]!);
    const y = asFloat(args[1]!);
    return x === undefined || y === undefined ? nored() : ok(gfloat(ff(x, y)));
  };
const numRound =
  (fi: (n: IntVal) => IntVal, ff: (x: number) => number): GroundFn =>
  (args) => {
    if (args.length !== 1) return ierr("expected exactly one argument");
    const a = args[0]!;
    if (a.kind === "gnd" && a.value.g === "int") return ok(gint(fi(a.value.n)));
    if (a.kind === "gnd" && a.value.g === "float") return ok(gfloat(ff(a.value.n)));
    return nored();
  };
const floatPred =
  (fb: (x: number) => boolean): GroundFn =>
  (args) => {
    if (args.length !== 1) return ierr("expected exactly one argument");
    const a = args[0]!;
    if (a.kind === "gnd" && a.value.g === "int") return ok(gbool(false));
    if (a.kind === "gnd" && a.value.g === "float") return ok(gbool(fb(a.value.n)));
    return nored();
  };

const mathEntries: Array<[string, GroundFn]> = [
  ["sqrt-math", floatUn(Math.sqrt)],
  ["sin-math", floatUn(Math.sin)],
  ["cos-math", floatUn(Math.cos)],
  ["tan-math", floatUn(Math.tan)],
  ["asin-math", floatUn(Math.asin)],
  ["acos-math", floatUn(Math.acos)],
  ["atan-math", floatUn(Math.atan)],
  ["pow-math", floatBin(Math.pow)],
  ["log-math", floatBin((base, input) => Math.log(input) / Math.log(base))],
  ["abs-math", numRound(intAbs, Math.abs)],
  ["trunc-math", numRound((n) => n, Math.trunc)],
  ["ceil-math", numRound((n) => n, Math.ceil)],
  ["floor-math", numRound((n) => n, Math.floor)],
  ["round-math", numRound((n) => n, Math.round)],
  ["isnan-math", floatPred(Number.isNaN)],
  ["isinf-math", floatPred((x) => !Number.isFinite(x) && !Number.isNaN(x))],
];

const coreEntries: Array<[string, GroundFn]> = [
  ["+", arithBin(addInt, (a, b) => a + b)],
  ["-", arithBin(subInt, (a, b) => a - b)],
  ["*", arithBin(mulInt, (a, b) => a * b)],
  ["<", numCmp((c) => c < 0)],
  ["<=", numCmp((c) => c <= 0)],
  [">", numCmp((c) => c > 0)],
  [">=", numCmp((c) => c >= 0)],
  ["==", eqAtom],
  ["!=", neqAtom],
  ["and", boolBin((a, b) => a && b)],
  ["or", boolBin((a, b) => a || b)],
  ["cons-atom", consAtom],
  ["decons-atom", deconsAtom],
  ["car-atom", carAtom],
  ["cdr-atom", cdrAtom],
  ["size-atom", sizeAtom],
  ["min-atom", minMaxAtom(true, "min-atom")],
  ["max-atom", minMaxAtom(false, "max-atom")],
  ["index-atom", indexAtom],
];

// --- stdlib grounded ops (LeaTTa Stdlib.lean stdGroundings) ---
const removeFirst = (a: Atom, xs: readonly Atom[]): Atom[] => {
  const i = xs.findIndex((x) => atomEq(x, a));
  return i < 0 ? [...xs] : [...xs.slice(0, i), ...xs.slice(i + 1)];
};
const msIntersect = (lhs: readonly Atom[], rhs: readonly Atom[]): Atom[] => {
  let pool = [...rhs];
  const out: Atom[] = [];
  for (const x of lhs)
    if (pool.some((y) => atomEq(y, x))) {
      out.push(x);
      pool = removeFirst(x, pool);
    }
  return out;
};
const msSubtract = (lhs: readonly Atom[], rhs: readonly Atom[]): Atom[] => {
  let pool = [...rhs];
  const out: Atom[] = [];
  for (const x of lhs) {
    if (pool.some((y) => atomEq(y, x))) pool = removeFirst(x, pool);
    else out.push(x);
  }
  return out;
};
const resultItems = (xs: readonly Atom[]): Atom[] =>
  xs.length > 0 && xs[0]!.kind === "sym" && xs[0]!.name === "," ? xs.slice(1) : [...xs];
const isResultBag = (xs: readonly Atom[]): boolean =>
  xs.length > 0 && xs[0]!.kind === "sym" && xs[0]!.name === ",";
const unionItems = (lhs: readonly Atom[], rhs: readonly Atom[]): Atom[] =>
  isResultBag(lhs) && isResultBag(rhs)
    ? [sym(","), ...lhs.slice(1), ...rhs.slice(1)]
    : [...lhs, ...rhs];
const removeFirstBy = (
  eq: (a: Atom, b: Atom) => boolean,
  a: Atom,
  xs: readonly Atom[],
): Atom[] | undefined => {
  const i = xs.findIndex((x) => eq(a, x));
  return i < 0 ? undefined : [...xs.slice(0, i), ...xs.slice(i + 1)];
};
const bagEqBy = (
  eq: (a: Atom, b: Atom) => boolean,
  as: readonly Atom[],
  bs: readonly Atom[],
): boolean => {
  let pool: Atom[] = [...bs];
  for (const a of as) {
    const r = removeFirstBy(eq, a, pool);
    if (r === undefined) return false;
    pool = r;
  }
  return pool.length === 0;
};
const exprArgs = (args: readonly Atom[]): Atom[][] | undefined => {
  const out: Atom[][] = [];
  for (const a of args) {
    if (a.kind !== "expr") return undefined;
    out.push([...a.items]);
  }
  return out;
};

const getMetatypeOp: GroundFn = (args) => {
  const a = args[0];
  if (args.length !== 1 || a === undefined) return ierr("get-metatype expects 1 argument");
  const k =
    a.kind === "sym"
      ? "Symbol"
      : a.kind === "var"
        ? "Variable"
        : a.kind === "expr"
          ? "Expression"
          : "Grounded";
  return ok(sym(k));
};
const assertEqOp =
  (eq: (a: Atom, b: Atom) => boolean): GroundFn =>
  (args) => {
    if (args.length !== 3 && args.length !== 4) return ierr("_assert-results-are-equal arity");
    const a0 = args[0];
    const e0 = args[1];
    if (a0?.kind !== "expr" || e0?.kind !== "expr") return ierr("expected two expressions");
    const okEq = bagEqBy(eq, resultItems(a0.items), resultItems(e0.items));
    if (okEq) return ok(emptyExpr);
    const msg = args.length === 4 ? args[3]! : sym("results-are-not-equal");
    return ok(expr([sym("Error"), args[2]!, msg]));
  };
// Printed-form (lexicographic) order, used by sort-strings (where alphabetical-by-text IS the spec) and
// sort-atom (which shares it). This is deliberately NOT msort/sort's structural `atomCmp` order: the two
// op families sort by different keys and the corpus relies on each, so they are kept distinct on purpose.
const sortByFormat = (xs: readonly Atom[]): Atom[] =>
  [...xs].sort((a, b) => (format(a) < format(b) ? -1 : format(a) > format(b) ? 1 : 0));

const DICT_SPACE_KIND = "dict-space";
type ExtGround = Extract<Ground, { readonly g: "ext" }>;
const dictSpaceEntriesByValue = new WeakMap<ExtGround, readonly Atom[]>();
let dictSpaceCounter = 0;

function makeDictSpace(entries: readonly Atom[]): Atom {
  const id = String(dictSpaceCounter++);
  const stored = [...entries];
  const value: ExtGround = { g: "ext", kind: DICT_SPACE_KIND, id };
  const atom = gnd(value, sym("Grounded"), undefined, (other) =>
    stored.flatMap((entry) => matchAtoms(entry, other)),
  );
  dictSpaceEntriesByValue.set(value, stored);
  return atom;
}

function dictSpaceEntries(atom: Atom): readonly Atom[] | undefined {
  if (atom.kind !== "gnd" || atom.value.g !== "ext" || atom.value.kind !== DICT_SPACE_KIND)
    return undefined;
  return dictSpaceEntriesByValue.get(atom.value);
}

function jsonToAtom(value: unknown): Atom {
  if (value === null) return sym("null");
  if (Array.isArray(value)) return expr(value.map(jsonToAtom));
  switch (typeof value) {
    case "string":
      return gstr(value);
    case "number":
      return Number.isInteger(value) ? gint(value) : gfloat(value);
    case "boolean":
      return gbool(value);
    case "object":
      return makeDictSpace(
        Object.entries(value as Record<string, unknown>).map(([k, v]) =>
          expr([sym(k), jsonToAtom(v)]),
        ),
      );
    default:
      return sym("null");
  }
}

function atomToJsonKey(atom: Atom): string {
  if (atom.kind === "gnd") {
    switch (atom.value.g) {
      case "str":
        return atom.value.s;
      case "int":
      case "float":
        return String(atom.value.n);
      case "bool":
        return String(atom.value.b);
      default:
        break;
    }
  }
  return atom.kind === "sym" ? atom.name : format(atom);
}

function atomToJson(atom: Atom): unknown {
  const entries = dictSpaceEntries(atom);
  if (entries !== undefined) {
    const out: Record<string, unknown> = {};
    for (const entry of entries) {
      if (entry.kind !== "expr") continue;
      const key = entry.items[0];
      const value = entry.items[1];
      if (key !== undefined && value !== undefined) out[atomToJsonKey(key)] = atomToJson(value);
    }
    return out;
  }
  if (atom.kind === "expr") return atom.items.map(atomToJson);
  if (atom.kind === "sym") return atom.name === "null" ? null : atom.name;
  if (atom.kind === "var") return format(atom);
  switch (atom.value.g) {
    case "str":
      return atom.value.s;
    case "int":
      return typeof atom.value.n === "bigint" ? Number(atom.value.n) : atom.value.n;
    case "float":
      return atom.value.n;
    case "bool":
      return atom.value.b;
    default:
      throw new Error(`json-encode: grounded value is not JSON-encodable: ${format(atom)}`);
  }
}

const dictSpaceOp: GroundFn = (args) => {
  const pairs = args[0];
  return args.length === 1 && pairs?.kind === "expr"
    ? ok(makeDictSpace(pairs.items))
    : ierr("dict-space expects one expression");
};

const jsonDecodeOp: GroundFn = (args) => {
  const text = asStr(args[0]!);
  if (args.length !== 1 || text === undefined) return ierr("json-decode expects one String");
  try {
    return ok(jsonToAtom(JSON.parse(text)));
  } catch (err) {
    return rerr(err instanceof Error ? `json-decode: ${err.message}` : "json-decode failed");
  }
};

const jsonEncodeOp: GroundFn = (args) => {
  const atom = args[0];
  if (args.length !== 1 || atom === undefined) return ierr("json-encode expects one Atom");
  try {
    const json = JSON.stringify(atomToJson(atom));
    return json === undefined ? rerr("json-encode: value is not JSON-encodable") : ok(gstr(json));
  } catch (err) {
    return rerr(err instanceof Error ? err.message : "json-encode failed");
  }
};

const FILE_HANDLE_KIND = "file-handle";
interface FileHandleRecord {
  readonly fs: HostFs;
  readonly fd: number;
  readonly path: string;
  cursor: number;
  readonly append: boolean;
  closed: boolean;
}
const fileHandles = new WeakMap<ExtGround, FileHandleRecord>();
const fileHandleFinalizer = new FinalizationRegistry<FileHandleRecord>((handle) => {
  if (handle.closed) return;
  handle.closed = true;
  try {
    handle.fs.closeSync(handle.fd);
  } catch {
    // Finalizers cannot report errors. Explicit file-close! returns an Error atom instead.
  }
});
let fileHandleCounter = 0;

function fileIoError(op: string, args: readonly Atom[], msg: string): ReduceResult {
  return ok(expr([sym("Error"), expr([sym(op), ...args]), gstr(msg)]));
}

function fileIoHost(op: string, args: readonly Atom[]): HostFs | ReduceResult {
  return getHostFs() ?? fileIoError(op, args, "file IO requires a host file system");
}

function gitImportError(op: string, args: readonly Atom[], msg: string): ReduceResult {
  return ok(expr([sym("Error"), expr([sym(op), ...args]), gstr(msg)]));
}

function gitImportHost(op: string, args: readonly Atom[]): HostGit | ReduceResult {
  return (
    getHostGit() ?? gitImportError(op, args, "git-import! requires node:child_process and node:fs")
  );
}

function hostCwd(): string | undefined {
  try {
    const proc = (
      globalThis as {
        readonly process?: {
          cwd?: () => string;
        };
      }
    ).process;
    return typeof proc?.cwd === "function" ? proc.cwd() : undefined;
  } catch {
    return undefined;
  }
}

function repoNameFromGitPath(gitPath: string): string | undefined {
  const trimmed = gitPath.replace(/[\/\\]+$/, "");
  const last = trimmed
    .split(/[\/:\\]+/)
    .filter(Boolean)
    .at(-1);
  if (last === undefined) return undefined;
  const name = last.endsWith(".git") ? last.slice(0, -4) : last;
  return name !== "" && name !== "." && name !== ".." ? name : undefined;
}

function joinHostPath(baseDir: string, name: string): string {
  return baseDir.replace(/[\/\\]+$/, "") + "/" + name;
}

function fileHandle(atom: Atom): FileHandleRecord | undefined {
  if (atom.kind !== "gnd" || atom.value.g !== "ext" || atom.value.kind !== FILE_HANDLE_KIND)
    return undefined;
  const handle = fileHandles.get(atom.value);
  return handle?.closed === false ? handle : undefined;
}

function makeFileHandle(fs: HostFs, fd: number, path: string, append: boolean): Atom {
  const id = `file-handle-${fileHandleCounter++}`;
  const value: ExtGround = { g: "ext", kind: FILE_HANDLE_KIND, id };
  const atom = gnd(value, sym("FileHandle"));
  const handle = { fs, fd, path, cursor: 0, append, closed: false };
  fileHandles.set(value, handle);
  fileHandleFinalizer.register(value, handle, value);
  return atom;
}

function fileSize(fs: HostFs, fd: number): number | undefined {
  const size = fs.fstatSync(fd).size;
  const n = typeof size === "bigint" ? Number(size) : size;
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

function readFromCursor(fs: HostFs, handle: FileHandleRecord, limit?: number): string {
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let remaining = limit ?? Number.POSITIVE_INFINITY;
  while (remaining > 0) {
    const chunkSize = Math.min(65_536, remaining);
    const buffer = new Uint8Array(chunkSize);
    const bytesRead = fs.readSync(handle.fd, buffer, 0, buffer.length, handle.cursor);
    if (bytesRead === 0) break;
    handle.cursor += bytesRead;
    remaining -= bytesRead;
    parts.push(decoder.decode(buffer.subarray(0, bytesRead), { stream: true }));
  }
  parts.push(decoder.decode());
  return parts.join("");
}

function parseFileOpenFlags(
  fs: HostFs,
  options: string,
): { readonly flags: number; readonly append: boolean } | { readonly error: string } {
  if (options.length === 0) return { error: "file-open!: expected at least one open option" };
  const chars = new Set(options);
  for (const ch of chars)
    if (!"rwcat".includes(ch)) return { error: `file-open!: unsupported open option '${ch}'` };
  const read = chars.has("r");
  const write = chars.has("w");
  const create = chars.has("c");
  const append = chars.has("a");
  const truncate = chars.has("t");
  if (create && !write) return { error: "file-open!: option c requires option w" };
  if (truncate && !write) return { error: "file-open!: option t requires option w" };
  if (!read && !write && !append) return { error: "file-open!: options must include r, w, or a" };

  const c = fs.constants;
  let flags = write || (read && append) ? c.O_RDWR : read ? c.O_RDONLY : c.O_WRONLY;
  if (create) flags |= c.O_CREAT;
  if (append) flags |= c.O_APPEND;
  if (truncate) flags |= c.O_TRUNC;
  return { flags, append };
}

const fileOpenOp: GroundFn = (args) => {
  const fs = fileIoHost("file-open!", args);
  if (!isHostFs(fs)) return fs;
  const path = args[0] === undefined ? undefined : asStr(args[0]);
  const options = args[1] === undefined ? undefined : asStr(args[1]);
  if (args.length !== 2 || path === undefined || options === undefined)
    return ierr("file-open! expects path and options Strings");
  const parsed = parseFileOpenFlags(fs, options);
  if ("error" in parsed) return fileIoError("file-open!", args, parsed.error);
  try {
    return ok(makeFileHandle(fs, fs.openSync(path, parsed.flags, 0o666), path, parsed.append));
  } catch (err) {
    return fileIoError(
      "file-open!",
      args,
      err instanceof Error
        ? `Failed to open file with provided path=${path} and options=${options}: ${err.message}`
        : `Failed to open file with provided path=${path} and options=${options}`,
    );
  }
};

const fileCloseOp: GroundFn = (args) => {
  const fs = fileIoHost("file-close!", args);
  if (!isHostFs(fs)) return fs;
  const atom = args[0];
  if (
    args.length !== 1 ||
    atom?.kind !== "gnd" ||
    atom.value.g !== "ext" ||
    atom.value.kind !== FILE_HANDLE_KIND
  )
    return ierr("file-close! expects one FileHandle");
  const handle = fileHandles.get(atom.value);
  if (handle === undefined || handle.closed)
    return fileIoError("file-close!", args, "FileHandle is already closed");
  try {
    fs.closeSync(handle.fd);
    handle.closed = true;
    fileHandles.delete(atom.value);
    fileHandleFinalizer.unregister(atom.value);
    return ok(emptyExpr);
  } catch (err) {
    return fileIoError(
      "file-close!",
      args,
      err instanceof Error ? `Failed to close file: ${err.message}` : "Failed to close file",
    );
  }
};

const fileReadToStringOp: GroundFn = (args) => {
  const fs = fileIoHost("file-read-to-string!", args);
  if (!isHostFs(fs)) return fs;
  const handle = args.length === 1 ? fileHandle(args[0]!) : undefined;
  if (handle === undefined) return ierr("file-read-to-string! expects one FileHandle");
  try {
    return ok(gstr(readFromCursor(fs, handle)));
  } catch (err) {
    return fileIoError(
      "file-read-to-string!",
      args,
      err instanceof Error
        ? `Failed to read file contents: ${err.message}`
        : "Failed to read file contents",
    );
  }
};

const fileReadExactOp: GroundFn = (args) => {
  const fs = fileIoHost("file-read-exact!", args);
  if (!isHostFs(fs)) return fs;
  const handle = args.length === 2 ? fileHandle(args[0]!) : undefined;
  const bytes = args[1] === undefined ? undefined : asByteOffset(args[1]);
  if (handle === undefined || bytes === undefined)
    return ierr("file-read-exact! expects FileHandle and non-negative byte count");
  try {
    return ok(gstr(readFromCursor(fs, handle, bytes)));
  } catch (err) {
    return fileIoError(
      "file-read-exact!",
      args,
      err instanceof Error ? `Read exact failed: ${err.message}` : "Read exact failed",
    );
  }
};

const fileWriteOp: GroundFn = (args) => {
  const fs = fileIoHost("file-write!", args);
  if (!isHostFs(fs)) return fs;
  const handle = args.length === 2 ? fileHandle(args[0]!) : undefined;
  const content = args[1] === undefined ? undefined : asStr(args[1]);
  if (handle === undefined || content === undefined)
    return ierr("file-write! expects FileHandle and String");
  try {
    const bytes = new TextEncoder().encode(content);
    let written = 0;
    while (written < bytes.length) {
      const n = fs.writeSync(
        handle.fd,
        bytes,
        written,
        bytes.length - written,
        handle.cursor + written,
      );
      if (n === 0) return fileIoError("file-write!", args, "Failed to write content to file");
      written += n;
    }
    handle.cursor += written;
    if (handle.append) handle.cursor = fileSize(fs, handle.fd) ?? handle.cursor;
    return ok(emptyExpr);
  } catch (err) {
    return fileIoError(
      "file-write!",
      args,
      err instanceof Error
        ? `Failed to write content to file: ${err.message}`
        : "Failed to write content to file",
    );
  }
};

const fileSeekOp: GroundFn = (args) => {
  const fs = fileIoHost("file-seek!", args);
  if (!isHostFs(fs)) return fs;
  const handle = args.length === 2 ? fileHandle(args[0]!) : undefined;
  const cursor = args[1] === undefined ? undefined : asByteOffset(args[1]);
  if (handle === undefined || cursor === undefined)
    return ierr("file-seek! expects FileHandle and non-negative byte position");
  handle.cursor = cursor;
  return ok(emptyExpr);
};

const fileGetSizeOp: GroundFn = (args) => {
  const fs = fileIoHost("file-get-size!", args);
  if (!isHostFs(fs)) return fs;
  const handle = args.length === 1 ? fileHandle(args[0]!) : undefined;
  if (handle === undefined) return ierr("file-get-size! expects one FileHandle");
  try {
    const size = fileSize(fs, handle.fd);
    return size === undefined
      ? fileIoError("file-get-size!", args, "Get size failed: file is too large")
      : ok(gint(size));
  } catch (err) {
    return fileIoError(
      "file-get-size!",
      args,
      err instanceof Error ? `Get size failed: ${err.message}` : "Get size failed",
    );
  }
};

const gitImportOp: GroundFn = (args) => {
  const host = gitImportHost("git-import!", args);
  if (!("fs" in host)) return host;
  if (args.length !== 1 && args.length !== 2)
    return ierr("git-import! expects repository URL String and optional base directory String");
  const gitPath = args[0] === undefined ? undefined : asStr(args[0]);
  const baseArg = args[1] === undefined ? undefined : asStr(args[1]);
  if (gitPath === undefined || (args.length === 2 && baseArg === undefined))
    return ierr("git-import! expects repository URL String and optional base directory String");
  const name = repoNameFromGitPath(gitPath);
  if (name === undefined)
    return gitImportError("git-import!", args, "git-import!: repository path has no basename");
  const cwd = hostCwd();
  if (cwd === undefined)
    return gitImportError(
      "git-import!",
      args,
      "git-import! requires a host current working directory",
    );
  const baseDir = baseArg ?? joinHostPath(cwd, "repos");
  if (baseDir === "")
    return gitImportError("git-import!", args, "git-import!: base directory must not be empty");
  const localDir = joinHostPath(baseDir, name);
  try {
    if (host.fs.existsSync(localDir)) {
      if (host.fs.statSync(localDir).isDirectory()) return ok(emptyExpr);
      return gitImportError(
        "git-import!",
        args,
        `git-import!: target exists and is not a directory: ${localDir}`,
      );
    }
    host.fs.mkdirSync(baseDir, { recursive: true });
    host.childProcess.execFileSync("git", ["clone", "--depth", "1", "--", gitPath, localDir], {
      stdio: "pipe",
    });
    return ok(emptyExpr);
  } catch (err) {
    return gitImportError(
      "git-import!",
      args,
      err instanceof Error
        ? `git-import!: failed to clone ${gitPath} into ${localDir}: ${err.message}`
        : `git-import!: failed to clone ${gitPath} into ${localDir}`,
    );
  }
};

// A minimal in-memory module catalog behind catalog-list!/update!/clear!. A real package catalog
// (versioned, on-disk or git-backed) is the module system's job; this holds the built-in module names so the
// operations exist, are documented, and list something. The Symbol argument is a catalog name or `all`.
const moduleCatalogs = new Map<string, string[]>([
  ["builtin", ["concurrency", "json", "catalog", "git"]],
]);
const catalogTargets = (arg: Atom | undefined): string[] => {
  const name = arg?.kind === "sym" ? arg.name : "all";
  return name === "all" ? [...moduleCatalogs.keys()] : [name];
};

const catalogClearOp: GroundFn = (args) => {
  for (const name of catalogTargets(args[0]))
    if (moduleCatalogs.has(name)) moduleCatalogs.set(name, []);
  return ok(emptyExpr);
};
const catalogListOp: GroundFn = (args) => {
  for (const name of catalogTargets(args[0]))
    outputSink(`${name}: ${(moduleCatalogs.get(name) ?? []).join(", ")}`);
  return ok(emptyExpr);
};
const catalogUpdateOp: GroundFn = (args) => {
  // No versioned backend yet, so updating a managed catalog reports success without changing it.
  catalogTargets(args[0]);
  return ok(emptyExpr);
};

const stdEntries: Array<[string, GroundFn]> = [
  ["catalog-clear!", catalogClearOp],
  ["catalog-list!", catalogListOp],
  ["catalog-update!", catalogUpdateOp],
  ["file-close!", fileCloseOp],
  ["file-get-size!", fileGetSizeOp],
  ["git-import!", gitImportOp],
  ["file-open!", fileOpenOp],
  ["file-read-exact!", fileReadExactOp],
  ["file-read-to-string!", fileReadToStringOp],
  ["file-seek!", fileSeekOp],
  ["file-write!", fileWriteOp],
  [
    "println!",
    (args) => {
      if (args.length !== 1) return ierr("println! expects 1 argument");
      outputSink(display(args[0]!));
      return ok(emptyExpr);
    },
  ],
  [
    // print! writes without a trailing newline (Hyperon semantics), via the raw sink, unlike println!.
    "print!",
    (args) => {
      if (args.length !== 1) return ierr("print! expects 1 argument");
      rawSink(display(args[0]!));
      return ok(emptyExpr);
    },
  ],
  [
    "format-args",
    (args) => {
      if (args.length !== 2) return ierr("format-args expects 2 arguments");
      const tmpl = args[0]!;
      const items = args[1]!;
      if (tmpl.kind !== "gnd" || tmpl.value.g !== "str")
        return ierr("format-args: first argument must be a String");
      if (items.kind !== "expr") return ierr("format-args: second argument must be an Expression");
      let i = 0;
      const out = tmpl.value.s.replace(/\{\}/g, () => {
        const it = items.items[i++];
        return it === undefined ? "{}" : display(it);
      });
      return ok(gstr(out));
    },
  ],
  [
    "repr",
    (args) => (args.length === 1 ? ok(gstr(format(args[0]!))) : ierr("repr expects 1 argument")),
  ],
  [
    "if-equal",
    (args) =>
      args.length === 4
        ? ok(alphaEq(args[0]!, args[1]!) ? args[2]! : args[3]!)
        : ierr("if-equal expects 4 arguments"),
  ],
  [
    "=alpha",
    (args) =>
      args.length === 2
        ? ok(gbool(alphaEq(args[0]!, args[1]!)))
        : ierr("=alpha expects 2 arguments"),
  ],
  ["get-metatype", getMetatypeOp],
  [
    "not",
    (args) => {
      const b = asBool(args[0]!);
      return args.length === 1 && b !== undefined ? ok(gbool(!b)) : ierr("not expects one Bool");
    },
  ],
  [
    "xor",
    (args) => {
      const x = asBool(args[0]!);
      const y = asBool(args[1]!);
      return args.length === 2 && x !== undefined && y !== undefined
        ? ok(gbool(x !== y))
        : ierr("xor expects two Bool");
    },
  ],
  [
    "/",
    (args) => {
      if (args.length === 2) {
        const a = asIntVal(args[0]!);
        const b = asIntVal(args[1]!);
        if (a !== undefined && b !== undefined)
          return isZero(b) ? rerr("DivisionByZero") : ok(gint(intDiv(a, b)));
      }
      return arithBin(intDiv, (x, y) => x / y)(args);
    },
  ],
  [
    "%",
    (args) => {
      const a = asIntVal(args[0]!);
      const b = asIntVal(args[1]!);
      if (args.length === 2 && a !== undefined && b !== undefined)
        return isZero(b) ? rerr("DivisionByZero") : ok(gint(intMod(a, b)));
      return ierr("% expects two Int atoms");
    },
  ],
  [
    "unique-atom",
    (args) => {
      const e = exprArgs(args);
      return e && e.length === 1
        ? ok(expr(dedupAlphaStable(e[0]!)))
        : ierr("unique-atom expects one expression");
    },
  ],
  [
    "union-atom",
    (args) => {
      const e = exprArgs(args);
      return e && e.length === 2
        ? ok(expr(unionItems(e[0]!, e[1]!)))
        : ierr("union-atom expects two expressions");
    },
  ],
  [
    "intersection-atom",
    (args) => {
      const e = exprArgs(args);
      return e && e.length === 2
        ? ok(expr(msIntersect(e[0]!, e[1]!)))
        : ierr("intersection-atom expects two expressions");
    },
  ],
  [
    "subtraction-atom",
    (args) => {
      const e = exprArgs(args);
      return e && e.length === 2
        ? ok(expr(msSubtract(e[0]!, e[1]!)))
        : ierr("subtraction-atom expects two expressions");
    },
  ],
  [
    "superpose",
    (args) => {
      const e = exprArgs(args);
      return e && e.length === 1
        ? ok(...resultItems(e[0]!))
        : ierr("superpose expects one expression");
    },
  ],
  [
    "hyperpose",
    (args) => {
      const e = exprArgs(args);
      return e && e.length === 1
        ? ok(...resultItems(e[0]!))
        : ierr("hyperpose expects one expression");
    },
  ],
  [
    "collapse-extract",
    (args) => {
      const e = exprArgs(args);
      if (!e || e.length !== 1) return ierr("collapse-extract expects one expression");
      // LeaTTa represents a collapsed bag as a comma tuple `(, r1 r2 ...)`. `resultItems` strips the comma
      // when a bag is spread back through `superpose`.
      return ok(
        expr([
          sym(","),
          ...e[0]!.map((p) => (p.kind === "expr" && p.items.length > 0 ? p.items[0]! : p)),
        ]),
      );
    },
  ],
  [
    "sealed",
    // Alpha-rename every variable in the atom (second argument) to a fresh, unique variable, except those in
    // the ignore list (first argument). The operation is Hyperon's `sealed`; it gives a higher-order template
    // (map-atom/filter-atom's body, an applied lambda) a private copy of its variables each time, so repeated
    // applications do not capture one another. (Previously a no-op, which silently broke that hygiene.)
    (args) => {
      if (args.length !== 2) return ierr("sealed expects (sealed <vars> <atom>)");
      const ignore = new Set(
        (args[0]!.kind === "expr" ? args[0]!.items : []).flatMap((v) =>
          v.kind === "var" ? [v.name] : [],
        ),
      );
      const fresh = atomVars(args[1]!).filter((v) => !ignore.has(v));
      if (fresh.length === 0) return ok(args[1]!);
      const sub: Subst = fresh.map((v) => [v, variable(v + "#" + String(sealCounter++))]);
      return ok(applySubst(sub, args[1]!));
    },
  ],
  ["nop", () => ok(emptyExpr)],
  ["dict-space", dictSpaceOp],
  ["json-decode", jsonDecodeOp],
  ["json-encode", jsonEncodeOp],
  // `pragma!` is handled as a stateful embedded op in eval.ts (it writes interpreter settings), not here.
  ["register-module!", () => ok(emptyExpr)],
  ["help!", () => ok(emptyExpr)],
  ["empty", () => ok()],
  [
    // `(test actual expected)` checks alpha-equivalence (exactly, no convention-forgiving), prints
    // "is X, should Y. ✅/❌", and reduces to `()` on pass. The MeTTa-TS corpus is written in MeTTa-TS
    // conventions, so this stays strict. MeTTa-TS is not bent to match PeTTa's rendering.
    "test",
    (args) => {
      if (args.length !== 2) return ierr("test expects 2 arguments");
      const passed = alphaEq(args[0]!, args[1]!);
      outputSink(`is ${format(args[0]!)}, should ${format(args[1]!)}. ${passed ? "✅" : "❌"}`);
      return passed
        ? ok(emptyExpr)
        : ok(expr([sym("Error"), expr([sym("test"), args[0]!, args[1]!]), sym("test-failed")]));
    },
  ],
  ["_assert-results-are-equal", assertEqOp(atomEq)],
  ["_assert-results-are-equal-msg", assertEqOp(atomEq)],
  ["_assert-results-are-alpha-equal", assertEqOp(alphaEq)],
  ["_assert-results-are-alpha-equal-msg", assertEqOp(alphaEq)],
  [
    "sort-atom",
    (args) => {
      const e = exprArgs(args);
      return e && e.length === 1
        ? ok(expr(sortByFormat(e[0]!)))
        : ierr("sort-atom expects one expression");
    },
  ],
  [
    "sort-strings",
    (args) => {
      const e = exprArgs(args);
      return e && e.length === 1
        ? ok(expr(sortByFormat(e[0]!)))
        : ierr("sort-strings expects one expression");
    },
  ],
];

// --- PeTTa-compat stdlib ---------------------------------------------------------------------------------
// Functions PeTTa auto-loads from `src/metta.pl` that Hyperon (and so MeTTa-TS) does not define, ported as
// grounded ops so the PeTTa example corpus runs against the same engine. Only NEW names are added; where a
// name already exists with Hyperon semantics (foldl-atom/map-atom/filter-atom are the Hyperon higher-order
// forms, repr/size-atom/index-atom/the *-atom set are already present) the existing op wins, so the Hyperon
// oracle is untouched. Semantics follow metta.pl exactly.
const exprItems = (a: Atom | undefined): readonly Atom[] | undefined =>
  a?.kind === "expr" ? a.items : undefined;
// Standard term order for sort/msort: numbers before symbols before strings before expressions; numbers by
// value, the rest by printed form (a practical stand-in for Prolog's standard order of terms).
const numVal = (a: Atom): number | undefined =>
  a.kind === "gnd" && (a.value.g === "int" || a.value.g === "float")
    ? Number(a.value.n)
    : undefined;
const termRank = (a: Atom): number =>
  numVal(a) !== undefined
    ? 0
    : a.kind === "var"
      ? 1
      : a.kind === "sym"
        ? 2
        : a.kind === "gnd"
          ? 3
          : 4;
// Total order on atoms: numbers first (by value), then variables, symbols, non-number grounded, and
// expressions, ranked by kind. Within the same rank, expressions compare STRUCTURALLY: shorter (lower
// arity) first, then element-wise rather than by their printed form, so e.g. `(wu (wu))` precedes
// `(wu (wu 42))` (a string compare would order them by the accident that a space sorts before `)`).
const atomCmp = (a: Atom, b: Atom): number => {
  const ra = termRank(a);
  const rb = termRank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 0) return numVal(a)! - numVal(b)!;
  if (a.kind === "expr" && b.kind === "expr") {
    if (a.items.length !== b.items.length) return a.items.length - b.items.length;
    for (let i = 0; i < a.items.length; i++) {
      const c = atomCmp(a.items[i]!, b.items[i]!);
      if (c !== 0) return c;
    }
    return 0;
  }
  const fa = format(a);
  const fb = format(b);
  return fa < fb ? -1 : fa > fb ? 1 : 0;
};
const sortStd = (xs: readonly Atom[]): Atom[] => [...xs].sort(atomCmp);
const dedup = (xs: readonly Atom[]): Atom[] => {
  const out: Atom[] = [];
  for (const x of xs) if (!out.some((y) => atomEq(y, x))) out.push(x);
  return out;
};
const metatypeOf = (a: Atom): string =>
  a.kind === "var"
    ? "Variable"
    : a.kind === "gnd"
      ? "Grounded"
      : a.kind === "expr"
        ? "Expression"
        : "Symbol";
const oneExpr = (name: string, args: readonly Atom[], f: (it: readonly Atom[]) => ReduceResult) => {
  const it = exprItems(args[0]);
  return args.length === 1 && it ? f(it) : ierr(`${name} expects one expression`);
};
const pettaEntries: Array<[string, GroundFn]> = [
  ["length", (a) => oneExpr("length", a, (it) => ok(gint(it.length)))],
  ["first", (a) => oneExpr("first", a, (it) => (it.length ? ok(it[0]!) : ierr("first: empty")))],
  [
    "last",
    (a) => oneExpr("last", a, (it) => (it.length ? ok(it[it.length - 1]!) : ierr("last: empty"))),
  ],
  ["reverse", (a) => oneExpr("reverse", a, (it) => ok(expr([...it].reverse())))],
  ["msort", (a) => oneExpr("msort", a, (it) => ok(expr(sortStd(it))))],
  ["sort", (a) => oneExpr("sort", a, (it) => ok(expr(dedup(sortStd(it)))))],
  ["list_to_set", (a) => oneExpr("list_to_set", a, (it) => ok(expr(dedup(it))))],
  // PeTTa metta.pl: dedupe a tuple modulo alpha-equivalence (two atoms equal up to a consistent
  // renaming of variables count as one). Hyperon has no such op; this is the alpha-aware sibling of
  // unique-atom, used by lib functions that work over patterns with variables.
  [
    "alpha-unique-atom",
    (a) => oneExpr("alpha-unique-atom", a, (it) => ok(expr(dedupAlphaStable(it)))),
  ],
  [
    "second-from-pair",
    (a) =>
      oneExpr("second-from-pair", a, (it) => (it.length >= 2 ? ok(it[1]!) : ierr("not a pair"))),
  ],
  [
    "append",
    (a) => {
      const x = exprItems(a[0]);
      const y = exprItems(a[1]);
      return a.length === 2 && x && y
        ? ok(expr([...x, ...y]))
        : ierr("append expects two expressions");
    },
  ],
  [
    "is-var",
    (a) => (a.length === 1 ? ok(gbool(a[0]!.kind === "var")) : ierr("is-var expects one atom")),
  ],
  [
    "is-ground",
    (a) =>
      a.length === 1 ? ok(gbool(atomVars(a[0]!).length === 0)) : ierr("is-ground expects one atom"),
  ],
  [
    "is-expr",
    (a) => (a.length === 1 ? ok(gbool(a[0]!.kind === "expr")) : ierr("is-expr expects one atom")),
  ],
  [
    "is-space",
    (a) =>
      a.length === 1
        ? ok(gbool(a[0]!.kind === "sym" && (a[0] as { name: string }).name.startsWith("&")))
        : ierr("is-space expects one atom"),
  ],
  [
    "get-mettatype",
    (a) => (a.length === 1 ? ok(sym(metatypeOf(a[0]!))) : ierr("get-mettatype expects one atom")),
  ],
  // Membership: `is-member`/`is-alpha-member` give a Bool; bare `member` succeeds (True) or yields nothing,
  // as in metta.pl's `member(X,L,true) :- member(X,L)`.
  [
    "is-member",
    (a) => {
      const l = exprItems(a[1]);
      return a.length === 2 && l
        ? ok(gbool(l.some((x) => atomEq(x, a[0]!))))
        : ierr("is-member expects (x expr)");
    },
  ],
  [
    "is-alpha-member",
    (a) => {
      const l = exprItems(a[1]);
      return a.length === 2 && l
        ? ok(gbool(l.some((x) => alphaEq(x, a[0]!))))
        : ierr("is-alpha-member expects (x expr)");
    },
  ],
  [
    "member",
    (a) => {
      const l = exprItems(a[1]);
      if (!(a.length === 2 && l)) return ierr("member expects (x expr)");
      return l.some((x) => atomEq(x, a[0]!)) ? ok(gbool(true)) : ok();
    },
  ],
  [
    "exclude-item",
    (a) => {
      const l = exprItems(a[1]);
      return a.length === 2 && l
        ? ok(expr(l.filter((x) => !atomEq(x, a[0]!))))
        : ierr("exclude-item expects (item expr)");
    },
  ],
  // numeric min/max of two numbers (Hyperon has only the list min-atom/max-atom). Int vs float preserved.
  [
    "min",
    (a) => {
      const x = asFloat(a[0]!);
      const y = asFloat(a[1]!);
      return a.length === 2 && x !== undefined && y !== undefined
        ? ok(x <= y ? a[0]! : a[1]!)
        : ierr("min expects two Numbers");
    },
  ],
  [
    "max",
    (a) => {
      const x = asFloat(a[0]!);
      const y = asFloat(a[1]!);
      return a.length === 2 && x !== undefined && y !== undefined
        ? ok(x >= y ? a[0]! : a[1]!)
        : ierr("max expects two Numbers");
    },
  ],
  // bare math names PeTTa registers alongside the *-math forms. log is (base value).
  ["sqrt", floatUn(Math.sqrt)],
  ["sin", floatUn(Math.sin)],
  ["cos", floatUn(Math.cos)],
  ["exp", floatUn(Math.exp)],
  ["log", floatBin((b, x) => Math.log(x) / Math.log(b))],
  // implies a b == (not a) or b
  [
    "implies",
    (a) => {
      const x = asBool(a[0]!);
      const y = asBool(a[1]!);
      return a.length === 2 && x !== undefined && y !== undefined
        ? ok(gbool(!x || y))
        : ierr("implies expects two Bools");
    },
  ],
  // string / atom construction
  [
    "concat",
    (a) => {
      const parts = a.map((x) => asStr(x) ?? format(x));
      return ok(gstr(parts.join("")));
    },
  ],
  [
    "atom_concat",
    (a) => ok(sym(a.map((x) => (x.kind === "sym" ? x.name : (asStr(x) ?? format(x)))).join(""))),
  ],
  // parse a string of MeTTa source into its (first) atom; sread is PeTTa's alias.
  [
    "parse",
    (a) => {
      const s = asStr(a[0]!);
      if (a.length !== 1 || s === undefined) return ierr("parse expects a String");
      const tops = parseAll(s, makeTokenizer());
      return tops.length > 0 ? ok(tops[0]!.atom) : ok(emptyExpr);
    },
  ],
  [
    "sread",
    (a) => {
      const s = asStr(a[0]!);
      if (a.length !== 1 || s === undefined) return ierr("sread expects a String");
      const tops = parseAll(s, makeTokenizer());
      return tops.length > 0 ? ok(tops[0]!.atom) : ok(emptyExpr);
    },
  ],
  // Effectful PeTTa ops: a random integer in [lo, hi), a random float in [lo, hi), and the wall-clock time.
  [
    "random-int",
    (a) => {
      const offset = a.length === 3 ? 1 : 0;
      const lo = asIntVal(a[offset]!);
      const hi = asIntVal(a[offset + 1]!);
      if ((a.length !== 2 && a.length !== 3) || lo === undefined || hi === undefined)
        return ierr("random-int expects an optional RNG and two Ints");
      const l = Number(lo);
      const h = Number(hi);
      if (h <= l)
        return ok(expr([sym("Error"), expr([sym("random-int"), ...a]), sym("RangeIsEmpty")]));
      return ok(gint(BigInt(l + Math.floor(Math.random() * (h - l)))));
    },
  ],
  [
    "random-float",
    (a) => {
      const lo = asFloat(a[0]!);
      const hi = asFloat(a[1]!);
      return a.length === 2 && lo !== undefined && hi !== undefined
        ? ok(gfloat(lo + Math.random() * (hi - lo)))
        : ierr("random-float expects two Numbers");
    },
  ],
  ["current-time", () => ok(gfloat(Date.now() / 1000))],
];

/** Names of the PeTTa-compat grounded ops. They yield to user `=` rules (PeTTa is rules-first, builtins as
 *  fallback), so a program that defines its own e.g. `sort`/`length` is not shadowed by the stdlib one. */
export const pettaOpNames: ReadonlySet<string> = new Set(pettaEntries.map(([n]) => n));

const TABLE_UNSAFE_GROUNDED_OPS: ReadonlySet<string> = new Set([
  "catalog-clear!",
  "catalog-list!",
  "catalog-update!",
  "current-time",
  "dict-space",
  "file-close!",
  "file-get-size!",
  "file-open!",
  "file-read-exact!",
  "file-read-to-string!",
  "file-seek!",
  "file-write!",
  "git-import!",
  "help!",
  "json-decode",
  "print!",
  "println!",
  "random-float",
  "random-int",
  "register-module!",
  "sealed",
  "test",
]);

const tableSafeGroundedFns = new Map<string, GroundFn>();
for (const [name, fn] of [...mathEntries, ...coreEntries, ...stdEntries, ...pettaEntries])
  if (!TABLE_UNSAFE_GROUNDED_OPS.has(name) && !tableSafeGroundedFns.has(name))
    tableSafeGroundedFns.set(name, fn);

const contextIndependentGroundedFns = new WeakSet<GroundFn>();
for (const [, fn] of [...mathEntries, ...coreEntries, ...stdEntries, ...pettaEntries])
  contextIndependentGroundedFns.add(fn);

/** True only for the unchanged built-in function registered under this name. */
export function isTableSafeGroundedOp(name: string, fn: GroundFn): boolean {
  return tableSafeGroundedFns.get(name) === fn;
}

/** True for built-in functions whose implementation cannot observe the dynamic interpreter context. */
export function isContextIndependentGroundedOp(fn: GroundFn): boolean {
  return contextIndependentGroundedFns.has(fn);
}

/** The arithmetic / boolean / list-surgery / math grounding core every KB starts with. */
export function baseTable(): GroundingTable {
  return new Map<string, GroundFn>([...mathEntries, ...coreEntries]);
}

/** The full standard-library grounding table (base + stdlib grounded ops + PeTTa-compat). Later entries do
 *  not override earlier ones (Map keeps the first), so Hyperon ops win any name shared with PeTTa-compat. */
export function stdTable(): GroundingTable {
  const t = new Map<string, GroundFn>([...mathEntries, ...coreEntries, ...stdEntries]);
  for (const [name, fn] of pettaEntries) if (!t.has(name)) t.set(name, fn);
  return t;
}

/** Dispatch `op` through the grounding table, or `noReduce` if unknown. */
export function callGrounded(
  gt: GroundingTable,
  op: string,
  args: readonly Atom[],
  context: GroundedCallContext = DEFAULT_GROUNDED_CALL_CONTEXT,
): ReduceResult {
  const fn = gt.get(op);
  return fn ? fn(args, context) : { tag: "noReduce" };
}
