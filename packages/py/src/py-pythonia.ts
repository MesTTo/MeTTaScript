// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

/**
 * pythonia (JSPyBridge) adapter: subprocess CPython with live object proxies. The package does not
 * depend on pythonia; the caller passes its `python` export in (the GifEncoderLib pattern):
 *
 *   import { python } from "pythonia";
 *   const bridge = pythoniaBridge(python);
 *   registerPyInterop(m, bridge);            // ... at the end: await bridge.dispose();
 *
 * Result normalization (verified against pythonia 1.2.6, Bridge.py:199-217): pythonia returns
 * str/int/float/None/bool as JS primitives (None -> null) and everything else as a proxy. Python
 * list and tuple proxies are deep-converted to arrays (janus parity, so a returned list becomes a
 * MeTTa expression); every other proxy (dict, instance, module, ndarray, callable) stays an opaque
 * handle. Detection uses isinstance against the cached list/tuple TYPE objects: pythonia does not
 * resolve a chained `type(v).__name__` in a single await (returns undefined), but a two-argument
 * isinstance is reliable. pythonia proxies are dynamically typed, so property access and calls go
 * through the small `attr`/`invoke`/`resolveProxy` helpers below, each a documented cast boundary.
 */
import { resolve } from "node:path";
import type { PyBridge, PyHandle, PyValue } from "./py";

/** The slice of pythonia this needs: the `python` import function, carrying `exit`. */
export interface PythoniaLike {
  (name: string): Promise<unknown>;
  exit(): void;
}

/** Read a property off a pythonia proxy (returns an awaitable/callable Intermediate). */
const attr = (obj: unknown, name: string): unknown => (obj as Record<string, unknown>)[name];

const PY_MARKER = "*** JS *** ";

/** Recover a readable message from a pythonia `PythonException`. pythonia leaves `.message` empty and
 *  writes the raised Python exception into `.stack` on a line prefixed with `*** JS *** `, e.g.
 *  `*** JS *** ZeroDivisionError: division by zero`. Return that line (the last one, the innermost
 *  exception), falling back to a non-empty `.message` or the string form for a plain JS error. */
export function pythonErrorText(e: unknown): string {
  const stack = (e as { stack?: unknown } | null)?.stack;
  if (typeof stack === "string") {
    const i = stack.lastIndexOf(PY_MARKER);
    if (i !== -1) {
      const line = stack
        .slice(i + PY_MARKER.length)
        .split("\n")[0]!
        .trim();
      if (line !== "") return line;
    }
  }
  if (e instanceof Error && e.message !== "") return e.message;
  const s = String(e);
  return s === "Error" || s === "[object Object]" ? "Python error" : s;
}

/** Call a pythonia proxy (or a proxy property) with args, returning its awaited result. A raised Python
 *  exception is re-thrown as a normal Error carrying the recovered message (pythonia's own is empty). */
const invoke = async (fn: unknown, args: unknown[]): Promise<unknown> => {
  try {
    return await (fn as (...a: unknown[]) => Promise<unknown>)(...args);
  } catch (e) {
    throw new Error(pythonErrorText(e));
  }
};

/** Force a bare proxy property access to resolve to its value (adopts the proxy's thenable). */
const resolveProxy = (thenable: unknown): Promise<unknown> => Promise.resolve(thenable);

/** pythonia proxies are callable objects (typeof "function"); primitives and null/undefined are not. */
const isProxy = (v: unknown): boolean =>
  v !== null && v !== undefined && (typeof v === "object" || typeof v === "function");

export function pythoniaBridge(python: PythoniaLike): PyBridge {
  const modules = new Map<string, Promise<unknown>>();
  const mod = (name: string): Promise<unknown> => {
    let m = modules.get(name);
    if (m === undefined) {
      m = python(name);
      modules.set(name, m);
    }
    return m;
  };
  const builtins = (): Promise<unknown> => mod("builtins");

  // Cached (list, tuple) TYPE objects for the isinstance sequence check (bare access, not a call).
  let seqTypes: Promise<[unknown, unknown]> | undefined;
  const sequenceTypes = (): Promise<[unknown, unknown]> => {
    seqTypes ??= (async (): Promise<[unknown, unknown]> => {
      const b = await builtins();
      return [await resolveProxy(attr(b, "list")), await resolveProxy(attr(b, "tuple"))];
    })();
    return seqTypes;
  };

  const toArgs = (args: PyValue[]): unknown[] =>
    args.map((a) => {
      if (typeof a === "bigint")
        throw new Error(`pythonia: integer argument ${a} exceeds the safe number range`);
      return a;
    });

  /** Deep-convert list/tuple proxies to arrays; leave every other proxy an opaque handle. */
  async function normalize(v: unknown): Promise<PyValue> {
    if (!isProxy(v)) return (v ?? null) as PyValue;
    const b = await builtins();
    const [listT, tupleT] = await sequenceTypes();
    const isSeq =
      Boolean(await invoke(attr(b, "isinstance"), [v, listT])) ||
      Boolean(await invoke(attr(b, "isinstance"), [v, tupleT]));
    if (!isSeq) return v as PyHandle;
    const n = Number(await invoke(attr(b, "len"), [v]));
    const out: PyValue[] = [];
    for (let i = 0; i < n; i++)
      out.push(await normalize(await invoke(attr(v, "__getitem__"), [i])));
    return out;
  }

  return {
    async callBuiltin(name, args) {
      return normalize(await invoke(attr(await builtins(), name), toArgs(args)));
    },
    async callModule(module, fn, args) {
      return normalize(await invoke(attr(await mod(module), fn), toArgs(args)));
    },
    async callMethod(obj, method, args) {
      return normalize(await invoke(attr(obj, method), toArgs(args)));
    },
    async call(fn, args) {
      return normalize(await invoke(fn, toArgs(args)));
    },
    async import(name) {
      if (name.endsWith(".py")) {
        // Resolve to an absolute path so pythonia uses resolve() rather than getCaller(), which
        // would locate the file relative to THIS adapter module instead of the program.
        const abs = resolve(name);
        const base = abs.slice(abs.lastIndexOf("/") + 1, -3);
        const p = python(abs);
        modules.set(base, p);
        await p;
      } else await mod(name);
    },
    isHandle(v): v is PyHandle {
      return isProxy(v);
    },
    dispose() {
      python.exit();
    },
  };
}
