#!/usr/bin/env node

// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// MeTTa TS command-line runner: `metta-ts <file.metta>` prints each !-query's results.
import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  format,
  setOutputSink,
  setRawSink,
  runProgramAsync,
  type RunOptions,
} from "@metta-ts/core";
import { runFile, readImports } from "./index";
import { checkFile } from "./check";

// Deep effectful MeTTa recursion can exceed V8's default call stack. Re-exec once with a larger stack,
// matching the reference interpreter's iterative driver. Set METTA_TS_STACK to skip (e.g. when embedding).
function reexecWithLargerStack(): void {
  const res = spawnSync(
    process.execPath,
    ["--stack-size=8000", fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: "inherit", env: { ...process.env, METTA_TS_STACK: "1" } },
  );
  process.exit(res.status ?? 1);
}

/** Run the file, buffering every byte it would print (query results plus eval-time `println!`/`print!`),
 *  and return it as one string. Buffering lets the optimistic default-stack attempt be discarded and
 *  retried under a bigger stack without a program that printed before overflowing double-printing. */
function runToBuffer(file: string, fuel: number | undefined, opts: RunOptions | undefined): string {
  const buf: string[] = [];
  const prevOut = setOutputSink((line) => buf.push(line + "\n"));
  const prevRaw = setRawSink((text) => buf.push(text));
  try {
    for (const r of runFile(file, fuel, opts))
      buf.push("[" + r.results.map(format).join(", ") + "]\n");
    return buf.join("");
  } finally {
    setOutputSink(prevOut);
    setRawSink(prevRaw);
  }
}

/** --py: run the file through the async runner with Python interop wired (pythonia). Dynamic
 *  imports keep the default path untouched; this branch is the only place pythonia/@metta-ts/py load,
 *  so a CLI run without --py neither needs nor starts a Python subprocess. */
async function runPyToBuffer(
  file: string,
  fuel: number | undefined,
  opts: RunOptions | undefined,
): Promise<string> {
  if (process.env.METTA_TS_FORCE_NO_PYTHONIA === "1")
    throw new Error("--py needs the pythonia backend; run: npm install pythonia");
  let python: import("@metta-ts/py").PythoniaLike;
  try {
    // `as string` stops TS resolving pythonia's own types here: it is a caller-supplied optional
    // backend, not a dependency of this package. The shape we use is PythoniaLike from @metta-ts/py.
    ({ python } = (await import("pythonia" as string)) as {
      python: import("@metta-ts/py").PythoniaLike;
    });
  } catch {
    throw new Error(
      "--py needs the pythonia backend; run: npm install pythonia (and ensure python3 is on PATH)",
    );
  }
  const { pythoniaBridge, pyCoreAsyncOps, PY_METTA_SRC } = await import("@metta-ts/py");
  const bridge = pythoniaBridge(python);
  const buf: string[] = [];
  const prevOut = setOutputSink((line) => buf.push(line + "\n"));
  const prevRaw = setRawSink((text) => buf.push(text));
  try {
    const src = readFileSync(file, "utf8");
    const fileDir = dirname(resolve(file));
    const results = await runProgramAsync(
      PY_METTA_SRC + "\n" + src,
      pyCoreAsyncOps(bridge),
      fuel,
      readImports(src, fileDir, dirname(fileDir)),
      opts ?? {},
    );
    for (const r of results) buf.push("[" + r.results.map(format).join(", ") + "]\n");
    return buf.join("");
  } finally {
    setOutputSink(prevOut);
    setRawSink(prevRaw);
    await bridge.dispose();
  }
}

function main(): void {
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
    },
  });
  const file = positionals[0];
  if (file === undefined) {
    process.stderr.write(
      "usage: metta-ts [--check [--json] [--undefined-symbols]] [--py] [--max-steps=N] [--max-stack-depth=N] [--hash-cons] [--flat-atomspace] <file.metta>\n",
    );
    process.exit(2);
  }
  // Static analysis short-circuit: `--check` runs the analyzer instead of evaluating, before the eval and
  // big-stack-reexec path below. `--json` emits the Diagnostic[] as JSON to stdout; otherwise the
  // rustc-style render goes to stderr (a diagnostic, not program output). Exit 1 on any error-severity diag.
  if (values.check === true) {
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
  // --py evaluates asynchronously (Python interop ops are async), so it takes its own path before the
  // sync runner and its big-stack reexec. Python-interop programs push the heavy work over IPC rather
  // than deep MeTTa recursion, so the default stack is enough here.
  if (values.py === true) {
    runPyToBuffer(file, fuel, opts)
      .then((s) => {
        process.stdout.write(s);
      })
      .catch((e: unknown) => {
        process.stderr.write(String(e instanceof Error ? e.message : e) + "\n");
        process.exit(1);
      });
    return;
  }
  // The child of a big-stack reexec (METTA_TS_STACK=1) already has the room, so it just runs. Otherwise
  // try on V8's default stack first: most programs fit, and skipping the second node startup is worth ~80ms
  // on a short run. Only a genuine stack overflow reexecs once with an 8 MB stack, re-running from the
  // buffered start so nothing prints twice.
  if (process.env.METTA_TS_STACK !== undefined) {
    process.stdout.write(runToBuffer(file, fuel, opts));
    return;
  }
  try {
    process.stdout.write(runToBuffer(file, fuel, opts));
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
    reexecWithLargerStack();
  }
}

main();
