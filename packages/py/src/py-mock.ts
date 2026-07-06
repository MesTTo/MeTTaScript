// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

/**
 * In-process fake Python for tests (the MockTransport analogue): a small object graph behind the
 * PyBridge interface, so py-call, py-eval/py-str, and the py-atom family are fully testable with no
 * Python installed. It is a faithful mini-CPython for the semantics the ops depend on:
 *
 * - modules/packages are nested handles; `__import__("a.b")` returns the TOP package `a` (as CPython
 *   does), so py-atom's import-longest-prefix + getattr-walk resolution is genuinely exercised;
 * - a function read by `getattr` comes back as a callable handle (`__call__`), matching how a bound
 *   Python method round-trips, so `callable` and `call` work for applied py-atoms;
 * - `eval` supports the literal grammar the tests use (numbers, quoted strings, flat [ ] lists,
 *   True/False/None, and one binary integer operator: ** + - *).
 *
 * Handles are objects tagged with a private symbol; primitives (number/string/bool/null) and JS
 * arrays (the mock's list/tuple representation) cross the boundary directly.
 */
import type { PyBridge, PyHandle, PyValue } from "./py";

const HANDLE = Symbol("mock-py-handle");
type MockFn = (...a: PyValue[]) => PyValue;
type MockAttr = PyValue | MockFn | MockHandle;
interface MockHandle {
  [HANDLE]: true;
  attrs: Map<string, MockAttr>;
}

const mkHandle = (entries: Record<string, MockAttr> = {}): MockHandle => ({
  [HANDLE]: true,
  attrs: new Map(Object.entries(entries)),
});

const isMockHandle = (v: unknown): v is MockHandle =>
  typeof v === "object" && v !== null && (v as MockHandle)[HANDLE] === true;

/** Python-style str() of a mock value. */
function pyStr(v: PyValue): string {
  if (v === null) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "number" || typeof v === "bigint") return String(v);
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return "[" + v.map(pyStr).join(", ") + "]";
  return "<py_object>";
}

/** Literal + one-binary-int-op evaluator for the eval() strings the tests use. */
function evalLiteral(src: string): PyValue {
  const s = src.trim();
  if (s === "None") return null;
  if (s === "True") return true;
  if (s === "False") return false;
  const bin = /^(-?\d+)\s*(\*\*|[+\-*])\s*(-?\d+)$/.exec(s);
  if (bin !== null) {
    const x = Number(bin[1]);
    const y = Number(bin[3]);
    switch (bin[2]) {
      case "**":
        return x ** y;
      case "+":
        return x + y;
      case "-":
        return x - y;
      default:
        return x * y;
    }
  }
  if (/^-?\d+\.\d+$/.test(s)) return Number(s);
  if (/^-?\d+$/.test(s)) return Number(s);
  const str = /^'([^']*)'$/.exec(s) ?? /^"([^"]*)"$/.exec(s);
  if (str !== null) return str[1]!;
  if (s.startsWith("[") && s.endsWith("]")) {
    const inner = s.slice(1, -1).trim();
    if (inner === "") return [];
    return inner.split(",").map((part) => evalLiteral(part)); // flat lists only
  }
  throw new Error(`mock eval: unsupported expression ${JSON.stringify(s)}`);
}

/** The pure builtins reachable by name (str/bool/len), shared by callBuiltin and the builtins handle. */
const BUILTIN_FNS: Record<string, MockFn> = {
  str: (v) => pyStr(v ?? null),
  bool: (v) => Boolean(v),
  len: (v) => {
    if (Array.isArray(v) || typeof v === "string") return v.length;
    throw new Error("len: unsupported operand");
  },
};

export class MockPyBridge implements PyBridge {
  /** Basenames passed to import(), for assertions. */
  readonly imported: string[] = [];

  // Top-level modules/packages, nested like real Python (sample.pkg is a submodule of sample).
  private readonly registry: Record<string, MockHandle> = {
    operator: mkHandle({
      add: (a, b) => {
        if (typeof a === "string" && typeof b === "string") return a + b;
        if (typeof a === "number" && typeof b === "number") return a + b;
        throw new Error("operator.add: unsupported operands");
      },
      or_: (a, b) => {
        if (typeof a === "number" && typeof b === "number") return a | b;
        throw new Error("operator.or_: unsupported operands");
      },
    }),
    sample: mkHandle({
      none: () => null,
      boom: () => {
        throw new Error("boom failed");
      },
      answer: 42,
      point: (x, y) =>
        mkHandle({
          x: x ?? null,
          y: y ?? null,
          magnitude: () => Math.hypot(Number(x), Number(y)),
        }),
      pkg: mkHandle({ double: (n) => Number(n) * 2 }),
    }),
    builtins: mkHandle(BUILTIN_FNS),
  };

  /** Walk a dotted module path through the handle tree; every segment must be a (sub)module handle. */
  private resolveModule(dotted: string): MockHandle {
    const parts = dotted.split(".");
    let cur = this.registry[parts[0]!];
    if (cur === undefined) throw new Error(`no module named ${dotted}`);
    for (const p of parts.slice(1)) {
      const next: MockAttr | undefined = cur.attrs.get(p);
      if (!isMockHandle(next)) throw new Error(`no module named ${dotted}`);
      cur = next;
    }
    return cur;
  }

  private getattr(h: MockHandle, name: string): PyValue {
    const v = h.attrs.get(name);
    if (v === undefined) throw new Error(`getattr: no attribute ${name}`);
    // A function comes back as a callable handle, matching a bound Python method round-tripping.
    return typeof v === "function" ? mkHandle({ __call__: v }) : (v as PyValue);
  }

  callBuiltin(name: string, args: PyValue[]): Promise<PyValue> {
    switch (name) {
      case "str":
      case "bool":
      case "len":
        return Promise.resolve(BUILTIN_FNS[name]!(...args));
      case "dict":
        return Promise.resolve(mkHandle());
      case "getattr": {
        const [h, attr] = args;
        if (isMockHandle(h) && typeof attr === "string")
          return Promise.resolve(this.getattr(h, attr));
        throw new Error("getattr: expected (handle, name)");
      }
      case "callable":
        return Promise.resolve(isMockHandle(args[0]) && args[0].attrs.has("__call__"));
      case "eval":
        return Promise.resolve(evalLiteral(String(args[0])));
      case "__import__": {
        const modName = String(args[0]);
        this.resolveModule(modName); // verify importable (throws otherwise)
        return Promise.resolve(this.registry[modName.split(".")[0]!]!); // CPython returns the top package
      }
      case "list":
      case "tuple": {
        const v = args[0];
        return Promise.resolve(Array.isArray(v) ? [...v] : []);
      }
      default:
        throw new Error(`mock builtins: no ${name}`);
    }
  }

  callModule(module: string, fn: string, args: PyValue[]): Promise<PyValue> {
    const raw = this.resolveModule(module).attrs.get(fn);
    if (typeof raw !== "function") throw new Error(`mock: ${module}.${fn} is not callable`);
    return Promise.resolve(raw(...args));
  }

  callMethod(obj: PyHandle, method: string, args: PyValue[]): Promise<PyValue> {
    if (!isMockHandle(obj)) throw new Error("callMethod: not a handle");
    if (method === "get") {
      const v = obj.attrs.get(String(args[0]));
      return Promise.resolve(v === undefined || typeof v === "function" ? null : (v as PyValue));
    }
    if (method === "__setitem__") {
      obj.attrs.set(String(args[0]), args[1] ?? null);
      return Promise.resolve(null);
    }
    const raw = obj.attrs.get(method);
    if (typeof raw === "function") return Promise.resolve(raw(...args));
    throw new Error(`callMethod: no method ${method}`);
  }

  call(fn: PyHandle, args: PyValue[]): Promise<PyValue> {
    if (isMockHandle(fn)) {
      const raw = fn.attrs.get("__call__");
      if (typeof raw === "function") return Promise.resolve(raw(...args));
    }
    throw new Error("call: not callable");
  }

  import(name: string): Promise<void> {
    const base = name.endsWith(".py") ? name.slice(name.lastIndexOf("/") + 1, -3) : name;
    this.imported.push(base);
    return Promise.resolve();
  }

  isHandle(v: PyValue): v is PyHandle {
    return isMockHandle(v);
  }

  dispose(): void {
    // nothing to shut down in-process
  }
}
