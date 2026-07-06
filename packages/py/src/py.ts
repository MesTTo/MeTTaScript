// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

/**
 * Python interop: PeTTa's `py-call` over a caller-supplied bridge.
 *
 * One grounded operation dispatches on the head of its expression argument:
 * - `.method`  `(py-call (.append $lst $x))`: method on a live handle (or a module, given a name)
 * - `mod.fn`   `(py-call (numpy.array (1 2 3)))`: module function, module = up to the LAST dot
 * - `fn`       `(py-call (str $x))`: a Python builtin
 * A single `(quote <spec>)` wrapper is unwrapped first, PeTTa's guard for heads that collide with
 * MeTTa operations (eval). Marshalling follows the janus defaults observed against live PeTTa:
 * numbers both ways; Python str -> Symbol; True/False/None <-> (@ true)/(@ false)/(@ none);
 * list -> expression (deep); everything else -> an opaque PyObject handle atom.
 *
 * Security: enabling this grants the program the host's Python (`py-eval` calls Python `eval` by
 * design). Opt-in only; never register it for untrusted MeTTa source.
 *
 * Do not declare a MeTTa type for `py-call`: an `Atom`-typed parameter would stop argument
 * reduction and break nested composition (`py-str` relies on inner `py-call`s reducing first).
 */
import type { AsyncGroundFn } from "@metta-ts/core";
import {
  Atom,
  ExpressionAtom,
  GroundedAtom,
  SymbolAtom,
  VariableAtom,
  ValueAtom,
  ValueObject,
  OperationObject,
  G,
  S,
  E,
  MeTTa,
} from "@metta-ts/hyperon";

/** Opaque live Python object reference held by the bridge. Never inspected here. */
export type PyHandle = object;

/** A value crossing the JS/Python boundary. `bigint` appears when a MeTTa integer exceeds the
 *  safe-number range; bridges decide how to carry it (the pythonia adapter refuses). */
export type PyValue = number | bigint | string | boolean | null | PyValue[] | PyHandle;

export interface PyBridge {
  /** builtins.name(args) */
  callBuiltin(name: string, args: PyValue[]): Promise<PyValue>;
  /** module.fn(args), importing the module if needed */
  callModule(module: string, fn: string, args: PyValue[]): Promise<PyValue>;
  /** obj.method(args) on a live handle */
  callMethod(obj: PyHandle, method: string, args: PyValue[]): Promise<PyValue>;
  /** fn(args) on a live callable handle (the py-atom surface applies callables through this) */
  call(fn: PyHandle, args: PyValue[]): Promise<PyValue>;
  /** Import a module by name, or a local `.py` path (registered under its basename). */
  import(name: string): Promise<void>;
  /** True when a value is an opaque handle rather than a converted primitive/list. */
  isHandle(v: PyValue): v is PyHandle;
  /** Shut the backend down (pythonia: python.exit()). */
  dispose(): Promise<void> | void;
}

/** Grounded wrapper marking a live Python object (the JsValue analogue). */
export class PyObjectValue extends ValueObject {}

const at = (word: string): ExpressionAtom => E(S("@"), S(word));

const SAFE_MIN = BigInt(Number.MIN_SAFE_INTEGER);
const SAFE_MAX = BigInt(Number.MAX_SAFE_INTEGER);

/** MeTTa atom -> bridge value, following the janus argument direction. */
export function atomToPy(atom: Atom, bridge: PyBridge): PyValue {
  if (atom instanceof GroundedAtom) {
    const o = atom.object();
    if (o instanceof PyObjectValue) return o.content as PyHandle;
    const v = o.content;
    if (typeof v === "bigint") {
      if (v >= SAFE_MIN && v <= SAFE_MAX) return Number(v);
      return v;
    }
    if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") return v;
    return v as PyValue; // a foreign grounded object: hand the bridge its content as-is
  }
  if (atom instanceof ExpressionAtom) {
    const ch = atom.children();
    if (ch.length === 2 && ch[0] instanceof SymbolAtom && ch[0].name() === "@") {
      const w = ch[1] instanceof SymbolAtom ? ch[1].name() : undefined;
      if (w === "true") return true;
      if (w === "false") return false;
      if (w === "none") return null;
    }
    return ch.map((c) => atomToPy(c, bridge));
  }
  if (atom instanceof SymbolAtom) {
    const n = atom.name();
    if (n === "True") return true;
    if (n === "False") return false;
    return n; // janus: atom -> str
  }
  if (atom instanceof VariableAtom) return atom.name();
  return atom.toString();
}

/** Bridge value -> MeTTa atom, following the observed janus result table. Arrays are checked
 *  before isHandle: by the bridge contract an array is always an already-converted list, never a
 *  handle (and TS narrowing needs the order too, since both are `object`). */
export function pyToAtom(v: PyValue, bridge: PyBridge): Atom {
  if (Array.isArray(v)) return E(...v.map((x) => pyToAtom(x, bridge)));
  if (bridge.isHandle(v)) return G(new PyObjectValue(v));
  if (v === null) return at("none");
  if (typeof v === "boolean") return at(v ? "true" : "false");
  if (typeof v === "bigint") {
    if (v >= SAFE_MIN && v <= SAFE_MAX) return ValueAtom(Number(v));
    throw new Error(`py: integer result ${v} exceeds the safe number range`);
  }
  if (typeof v === "number") return ValueAtom(v);
  if (typeof v === "string") return S(v); // janus py_string_as(atom): str -> Symbol
  // A bridge that returns a non-handle object breaks its own contract; fail loudly.
  throw new Error("py: bridge returned a non-primitive value it does not claim as a handle");
}

/** The callable name behind a head atom: a Symbol's name, or a String's content (PeTTa's
 *  `string(Spec) -> atom_string` coercion). */
function headName(atom: Atom | undefined): string | undefined {
  if (atom instanceof SymbolAtom) return atom.name();
  if (atom instanceof GroundedAtom) {
    const c = atom.object().content;
    if (typeof c === "string") return c;
  }
  return undefined;
}

/** One py-call: unwrap an optional (quote ...), dispatch on the head, marshal the result. */
async function dispatchPyCall(bridge: PyBridge, specAtom: Atom | undefined): Promise<Atom> {
  let spec = specAtom;
  if (spec instanceof ExpressionAtom) {
    const ch = spec.children();
    if (ch.length === 2 && ch[0] instanceof SymbolAtom && ch[0].name() === "quote") spec = ch[1];
  }
  if (!(spec instanceof ExpressionAtom))
    throw new Error("py-call: expected (py-call (<fn> <arg>...))");
  const [h, ...argAtoms] = spec.children();
  const name = headName(h);
  if (name === undefined) throw new Error("py-call: head must be a Symbol or String");
  const args = argAtoms.map((a) => atomToPy(a, bridge));
  let result: PyValue;
  if (name.startsWith(".")) {
    const method = name.slice(1);
    const target = args[0];
    if (target === undefined) throw new Error(`py-call: (.${method} ...) needs a target argument`);
    const rest = args.slice(1);
    if (bridge.isHandle(target)) result = await bridge.callMethod(target, method, rest);
    else if (typeof target === "string") result = await bridge.callModule(target, method, rest);
    else throw new Error(`py-call: .${method} target must be a Python object or a module name`);
  } else if (name.includes(".")) {
    const i = name.lastIndexOf(".");
    result = await bridge.callModule(name.slice(0, i), name.slice(i + 1), args);
  } else {
    result = await bridge.callBuiltin(name, args);
  }
  return pyToAtom(result, bridge);
}

function asImportName(atom: Atom | undefined): string {
  const n = headName(atom);
  if (n === undefined) throw new Error('py-import: expected a module name or "./path.py"');
  return n;
}

// ---- The Hyperon `py-atom` surface -------------------------------------------------------------
//
// Ports hyperon/stdlib.py (get_py_atom, do_py_dot, _py_tuple_list, py_dict, py_chain) over the same
// bridge, with three deliberate divergences: no one-line-exec resolution fallback (their own FIXME),
// no `unwrap` mode (raw atoms cannot cross a subprocess bridge), no __main__ scope.

/** Resolve a dotted path to a Python value/handle by importing the longest importable prefix, then
 *  walking the rest with getattr from the top-level module (CPython's `__import__("a.b")` returns a).
 *  A bare or unresolved name falls back to a builtin. Throws if nothing resolves. */
async function resolvePath(bridge: PyBridge, path: string): Promise<PyValue> {
  const parts = path.split(".");
  for (let cut = parts.length; cut >= 1; cut--) {
    let top: PyValue;
    try {
      top = await bridge.callBuiltin("__import__", [parts.slice(0, cut).join(".")]);
    } catch {
      continue;
    }
    try {
      let v: PyValue = top;
      for (const seg of parts.slice(1)) v = await bridge.callBuiltin("getattr", [v, seg]);
      return v;
    } catch {
      continue;
    }
  }
  const builtins = await bridge.callBuiltin("__import__", ["builtins"]);
  return bridge.callBuiltin("getattr", [builtins, path]); // throws if not a builtin either
}

/** Wrap a resolved Python object as an atom: a callable becomes an applicable grounded operation
 *  (its exec calls the object through the bridge, async), a non-callable becomes its marshaled value. */
async function resolvedToAtom(
  bridge: PyBridge,
  name: string,
  v: PyValue,
  typeAtom: Atom | undefined,
): Promise<Atom> {
  if (bridge.isHandle(v) && Boolean(await bridge.callBuiltin("callable", [v]))) {
    const op = new OperationObject(name, (...callArgs: Atom[]) =>
      bridge
        .call(
          v,
          callArgs.map((a) => atomToPy(a, bridge)),
        )
        .then((r) => [pyToAtom(r, bridge)]),
    );
    return G(op, typeAtom);
  }
  return pyToAtom(v, bridge);
}

/** Build a nested Python list/tuple from a nested MeTTa expression (hyperon `_py_tuple_list`). */
async function buildCollection(
  bridge: PyBridge,
  atom: Atom | undefined,
  kind: "list" | "tuple",
): Promise<Atom> {
  if (!(atom instanceof ExpressionAtom)) throw new Error(`py-${kind}: expected an expression`);
  const build = async (e: ExpressionAtom): Promise<PyValue> => {
    const items: PyValue[] = [];
    for (const c of e.children())
      items.push(c instanceof ExpressionAtom ? await build(c) : atomToPy(c, bridge));
    return bridge.callBuiltin(kind, [items]);
  };
  return G(new PyObjectValue((await build(atom)) as PyHandle));
}

/** PeTTa's MeTTa-level helpers (PeTTa lib/lib_llm.metta), loaded by registerPyInterop.
 *  py-eval is verbatim. py-str is behavior-identical but expressed with `case`: lib_llm's two
 *  overlapping clauses rely on Prolog failure-pruning (car-atom on () fails, killing the branch);
 *  under MeTTa's nondeterministic `=` both clauses fire on () and the error atom recurses forever.
 *  `case` commits to the first matching branch in both engines (verified on live PeTTa: ab1/1024
 *  and (py-str ()) -> "" match). */
export const PY_METTA_SRC = `
(= (py-eval $str)
   (let $dict (py-call (dict))
        (py-call (quote (eval $str $dict $dict)))))
(= (py-str-helper $L $out)
   (case $L
     ((() $out)
      ($rest (let* (($head (car-atom $rest))
                    ($tail (cdr-atom $rest))
                    ($out2 (py-call (operator.add $out (py-call (str $head))))))
               (py-str-helper $tail $out2))))))
(= (py-str $L) (py-str-helper $L ""))
`;

/** The interop operations at the runner level, shared by both registration paths. */
export function pyOps(bridge: PyBridge): Map<string, (args: Atom[]) => Promise<Atom[]>> {
  return new Map<string, (args: Atom[]) => Promise<Atom[]>>([
    ["py-call", async (args: Atom[]): Promise<Atom[]> => [await dispatchPyCall(bridge, args[0])]],
    [
      "py-import",
      async (args: Atom[]): Promise<Atom[]> => {
        await bridge.import(asImportName(args[0]));
        return [E()];
      },
    ],
    [
      "py-atom",
      async (args: Atom[]): Promise<Atom[]> => {
        const name = headName(args[0]);
        if (name === undefined) throw new Error("py-atom: expected a Symbol or String path");
        return [await resolvedToAtom(bridge, name, await resolvePath(bridge, name), args[1])];
      },
    ],
    [
      "py-dot",
      async (args: Atom[]): Promise<Atom[]> => {
        const name = headName(args[1]);
        if (args[0] === undefined || name === undefined)
          throw new Error("py-dot: expected (py-dot <object> <attr>)");
        const obj = atomToPy(args[0], bridge);
        if (!bridge.isHandle(obj)) throw new Error("py-dot: first argument must be a live handle");
        const v = await bridge.callBuiltin("getattr", [obj, name]);
        return [await resolvedToAtom(bridge, name, v, args[2])];
      },
    ],
    [
      "py-list",
      async (args: Atom[]): Promise<Atom[]> => [await buildCollection(bridge, args[0], "list")],
    ],
    [
      "py-tuple",
      async (args: Atom[]): Promise<Atom[]> => [await buildCollection(bridge, args[0], "tuple")],
    ],
    [
      "py-dict",
      async (args: Atom[]): Promise<Atom[]> => {
        const e = args[0];
        if (!(e instanceof ExpressionAtom)) throw new Error("py-dict: expected ((key value) ...)");
        const dict = await bridge.callBuiltin("dict", []);
        if (!bridge.isHandle(dict))
          throw new Error("py-dict: bridge dict() did not return a handle");
        for (const pair of e.children()) {
          if (!(pair instanceof ExpressionAtom) || pair.children().length !== 2)
            throw new Error("py-dict: each entry must be a (key value) pair");
          const [k, v] = pair.children();
          // A symbol key is a string; anything else marshals normally (hyperon is_symbol_to_str).
          const key = k instanceof SymbolAtom ? k.name() : atomToPy(k!, bridge);
          await bridge.callMethod(dict, "__setitem__", [key, atomToPy(v!, bridge)]);
        }
        return [G(new PyObjectValue(dict))];
      },
    ],
    [
      "py-chain",
      async (args: Atom[]): Promise<Atom[]> => {
        const e = args[0];
        if (!(e instanceof ExpressionAtom) || e.children().length === 0)
          throw new Error("py-chain: expected a non-empty expression");
        const vs = e.children().map((c) => atomToPy(c, bridge));
        let acc: PyValue = vs[0]!;
        for (const v of vs.slice(1)) acc = await bridge.callModule("operator", "or_", [acc, v]);
        return [pyToAtom(acc, bridge)];
      },
    ],
  ]);
}

/** Register py-call/py-import (async) on a runner and load the py-eval/py-str helpers. */
export function registerPyInterop(m: MeTTa, bridge: PyBridge): void {
  for (const [name, fn] of pyOps(bridge)) m.registerAsyncOperation(name, fn);
  m.run(PY_METTA_SRC);
}

/** The same operations as core-level async ops for `runProgramAsync` embedders (the CLI's --py).
 *  Callers evaluate `PY_METTA_SRC + "\n" + program` so the helpers are defined. */
export function pyCoreAsyncOps(bridge: PyBridge): Map<string, AsyncGroundFn> {
  const out = new Map<string, AsyncGroundFn>();
  for (const [name, fn] of pyOps(bridge))
    out.set(name, async (args) => {
      try {
        const results = await fn(args.map((a) => Atom.fromCAtom(a)));
        return { tag: "ok", results: results.map((a) => a.catom) };
      } catch (e) {
        return { tag: "runtimeError", msg: e instanceof Error ? e.message : String(e) };
      }
    });
  return out;
}
