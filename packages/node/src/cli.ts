#!/usr/bin/env node

// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// MeTTa TS command-line runner: `metta-ts <file.metta>` prints each !-query's results.
import { parseArgs } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import {
  atomEq,
  emptyExpr,
  format,
  isErrorAtom,
  setOutputSink,
  setRawSink,
  type Atom,
  type QueryResult,
  type ReduceResult,
  type RunOptions,
} from "@metta-ts/core";
import type { HostInterop } from "@metta-ts/core/host";
import { readImports } from "./file-imports";

// Deep effectful MeTTa recursion can exceed V8's default call stack. Re-exec once with a larger stack,
// matching the reference interpreter's iterative driver. Set METTA_TS_STACK to skip (e.g. when embedding).
async function reexecWithLargerStack(): Promise<never> {
  const [{ spawnSync }, { fileURLToPath }] = await Promise.all([
    import("node:child_process"),
    import("node:url"),
  ]);
  const res = spawnSync(
    process.execPath,
    ["--stack-size=8000", fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: "inherit", env: { ...process.env, METTA_TS_STACK: "1" } },
  );
  process.exit(res.status ?? 1);
}

async function runCliSource(
  src: string,
  fuel: number | undefined,
  imports: Map<string, Atom[]>,
  opts: RunOptions | undefined,
  includeNonBang: boolean,
): Promise<QueryResult[]> {
  // A callable head can be constructed at runtime, so source text cannot soundly prove that `hyperpose`
  // is unreachable. Install the worker hook for every normal CLI run; workers are created only if the
  // evaluator reaches `(once (hyperpose ...))`.
  const { runSource, runSourceAllDirectives } = await import("./source");
  return includeNonBang
    ? runSourceAllDirectives(src, fuel, imports, opts)
    : runSource(src, fuel, imports, opts);
}

/** Run the file, buffering every byte it would print (query results plus eval-time `println!`/`print!`),
 *  and return it as one string. Buffering lets the optimistic default-stack attempt be discarded and
 *  retried under a bigger stack without a program that printed before overflowing double-printing. */

async function runToBuffer(
  file: string,
  fuel: number | undefined,
  opts: RunOptions | undefined,
  includeNonBang: boolean,
): Promise<string> {
  const src = readFileSync(file, "utf8");
  const fileDir = dirname(resolve(file));
  const imports = readImports(src, fileDir, dirname(fileDir));
  const buf: string[] = [];
  const prevOut = setOutputSink((line) => buf.push(line + "\n"));
  const prevRaw = setRawSink((text) => buf.push(text));
  try {
    const results = await runCliSource(src, fuel, imports, opts, includeNonBang);
    for (const r of results)
      buf.push(
        "[" +
          r.results
            .map((a) => formatCliResult(a, includeNonBang ? r.query : undefined))
            .join(", ") +
          "]\n",
      );
    return buf.join("");
  } finally {
    setOutputSink(prevOut);
    setRawSink(prevRaw);
  }
}

function formatCliResult(atom: Atom, query?: Atom): string {
  if (query !== undefined && isErrorAtom(atom) && atomEq(atom, query) && atom.kind === "expr")
    return "( " + atom.items.map(format).join(" ") + ")";
  return format(atom);
}

function importName(a: Atom | undefined): string | undefined {
  if (a?.kind === "sym") return a.name;
  if (a?.kind === "gnd" && a.value.g === "str") return a.value.s;
  if (
    a?.kind === "expr" &&
    a.items.length === 2 &&
    a.items[0]?.kind === "sym" &&
    a.items[0].name === "library"
  )
    return importName(a.items[1]);
  return undefined;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function resolveHostPath(fileDir: string, name: string): string {
  const fileRelative = resolve(fileDir, name);
  if (existsSync(fileRelative)) return fileRelative;
  return resolve(name);
}

/** --py/--prolog: run through the async runner with requested host interop wired. Dynamic imports keep
 *  the default path untouched, so a normal CLI run does not need Python, SWI-Prolog, or async ops. */
async function runInteropToBuffer(
  file: string,
  fuel: number | undefined,
  opts: RunOptions | undefined,
  modes: { readonly py: boolean; readonly prolog: boolean },
): Promise<string> {
  const [{ composeHostInterops }, { runSourceAsync }] = await Promise.all([
    import("@metta-ts/core/host"),
    import("./source"),
  ]);
  const interops: HostInterop[] = [];
  const src = readFileSync(file, "utf8");
  const fileDir = dirname(resolve(file));
  const resolveImportPath = (p: string): string => resolveHostPath(fileDir, p);
  if (modes.py) {
    if (process.env.METTA_TS_FORCE_NO_PYTHONIA === "1")
      throw new Error("--py needs the pythonia backend; run: npm install pythonia");
    let python: import("@metta-ts/py/pythonia").PythoniaLike;
    try {
      // `as string` stops TS resolving pythonia's own types here: it is a caller-supplied optional
      // backend, not a dependency of this package. The shape we use is the pythonia subpath type.
      ({ python } = (await import("pythonia" as string)) as {
        python: import("@metta-ts/py/pythonia").PythoniaLike;
      });
    } catch {
      throw new Error(
        "--py needs the pythonia backend; run: npm install pythonia (and ensure python3 is on PATH)",
      );
    }
    const [{ pyCoreAsyncOps, PY_METTA_SRC }, { pythoniaBridge }] = await Promise.all([
      import("@metta-ts/py"),
      import("@metta-ts/py/pythonia"),
    ]);
    const bridge = pythoniaBridge(python);
    interops.push({
      name: "pythonia",
      prelude: PY_METTA_SRC,
      asyncOps: pyCoreAsyncOps(bridge),
      hostImport: async (_space, target): Promise<ReduceResult> => {
        const name = importName(target);
        if (!name?.endsWith(".py")) return { tag: "noReduce" };
        try {
          await bridge.import(resolveImportPath(name));
          return { tag: "ok", results: [emptyExpr] };
        } catch (e) {
          return { tag: "runtimeError", msg: `import!: ${name}: ${errorMessage(e)}` };
        }
      },
      dispose: () => bridge.dispose(),
    });
  }
  if (modes.prolog) {
    if (process.env.METTA_TS_FORCE_NO_SWIPL === "1")
      throw new Error("--prolog needs SWI-Prolog on PATH; install swipl");
    const [{ PROLOG_METTA_SRC, prologCoreAsyncOps }, { swiPrologBridge }] = await Promise.all([
      import("@metta-ts/prolog"),
      import("@metta-ts/prolog/swi-node"),
    ]);
    const bridge = swiPrologBridge();
    interops.push({
      name: "swi-prolog",
      prelude: PROLOG_METTA_SRC,
      asyncOps: prologCoreAsyncOps(bridge, {
        resolvePath: resolveImportPath,
      }),
      hostImport: async (_space, target): Promise<ReduceResult> => {
        const name = importName(target);
        if (!name?.endsWith(".pl")) return { tag: "noReduce" };
        try {
          await bridge.consult(resolveImportPath(name));
          return { tag: "ok", results: [emptyExpr] };
        } catch (e) {
          return { tag: "runtimeError", msg: `import!: ${name}: ${errorMessage(e)}` };
        }
      },
      dispose: () => bridge.dispose(),
    });
  }
  const host = composeHostInterops(interops);
  const buf: string[] = [];
  const prevOut = setOutputSink((line) => buf.push(line + "\n"));
  const prevRaw = setRawSink((text) => buf.push(text));
  try {
    const results = await runSourceAsync(
      host.prelude === undefined ? src : `${host.prelude}\n${src}`,
      new Map(host.asyncOps ?? []),
      fuel,
      readImports(src, fileDir, dirname(fileDir)),
      {
        ...(opts ?? {}),
        ...(host.hostImport !== undefined ? { hostImport: host.hostImport } : {}),
      },
    );
    for (const r of results) buf.push("[" + r.results.map(format).join(", ") + "]\n");
    return buf.join("");
  } finally {
    setOutputSink(prevOut);
    setRawSink(prevRaw);
    await host.dispose?.();
  }
}

async function main(): Promise<void> {
  // CLI resource limits: `--max-steps` is the step ceiling, and `--max-stack-depth` seeds the interpreter
  // stack-depth bound a program can further tighten with `pragma!`.
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      "max-steps": { type: "string" },
      "max-stack-depth": { type: "string" },
      "hash-cons": { type: "boolean" },
      "flat-atomspace": { type: "boolean" },
      check: { type: "boolean" },
      json: { type: "boolean" },
      "undefined-symbols": { type: "boolean" },
      py: { type: "boolean" },
      prolog: { type: "boolean" },
      conformance: { type: "boolean" },
    },
  });
  const file = positionals[0];
  if (file === undefined) {
    process.stderr.write(
      "usage: metta-ts [--check [--json] [--undefined-symbols]] [--py] [--prolog] [--conformance] [--max-steps=N] [--max-stack-depth=N] [--hash-cons] <file.metta>\n",
    );
    process.exit(2);
  }
  // Static analysis short-circuit: `--check` runs the analyzer instead of evaluating, before the eval and
  // big-stack-reexec path below. `--json` emits the Diagnostic[] as JSON to stdout; otherwise the
  // rustc-style render goes to stderr (a diagnostic, not program output). Exit 1 on any error-severity diag.
  if (values.check === true) {
    const { checkFile } = await import("./check");
    const { text, exitCode } = checkFile(file, {
      json: values.json === true,
      undefinedSymbols: values["undefined-symbols"] === true,
    });
    if (text.length > 0) {
      (values.json === true ? process.stdout : process.stderr).write(text + "\n");
    }
    process.exit(exitCode);
  }
  const fuel = values["max-steps"] !== undefined ? Number(values["max-steps"]) : undefined;
  const maxStackDepth =
    values["max-stack-depth"] !== undefined ? Number(values["max-stack-depth"]) : undefined;
  const hashCons =
    values["hash-cons"] === true ||
    process.env.METTA_TS_HASHCONS === "1" ||
    process.env.METTA_TS_HASHCONS === "true";
  const flatAtomspace =
    values["flat-atomspace"] === true ||
    process.env.METTA_TS_FLAT_ATOMSPACE === "1" ||
    process.env.METTA_TS_FLAT_ATOMSPACE === "true";
  const opts: RunOptions | undefined =
    maxStackDepth !== undefined || hashCons || flatAtomspace
      ? {
          ...(maxStackDepth !== undefined ? { maxStackDepth } : {}),
          ...(hashCons || flatAtomspace
            ? {
                experimental: {
                  ...(hashCons ? { hashCons: true } : {}),
                  ...(flatAtomspace ? { flatAtomspace: true } : {}),
                },
              }
            : {}),
        }
      : undefined;
  // Host interop evaluates asynchronously, so it takes its own path before the sync runner and its
  // big-stack reexec. These programs push the external work over IPC rather than deep MeTTa recursion.
  if (values.py === true || values.prolog === true) {
    const output = await runInteropToBuffer(file, fuel, opts, {
      py: values.py === true,
      prolog: values.prolog === true,
    });
    process.stdout.write(output);
    return;
  }
  // The child of a big-stack reexec (METTA_TS_STACK=1) already has the room, so it just runs. Otherwise
  // try on V8's default stack first: most programs fit, and skipping the second node startup is worth ~80ms
  // on a short run. Only a genuine stack overflow reexecs once with an 8 MB stack, re-running from the
  // buffered start so nothing prints twice.
  if (process.env.METTA_TS_STACK !== undefined) {
    process.stdout.write(await runToBuffer(file, fuel, opts, values.conformance === true));
    return;
  }
  try {
    process.stdout.write(await runToBuffer(file, fuel, opts, values.conformance === true));
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
    await reexecWithLargerStack();
  }
}

main().catch((e: unknown) => {
  process.stderr.write(errorMessage(e) + "\n");
  process.exit(1);
});
