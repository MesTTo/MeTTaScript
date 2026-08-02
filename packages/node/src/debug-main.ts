// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// The `metta debug` / `metta-debug` engine-debugger logic: the Node shell around the host-free
// `@metta-ts/debug` engine. File loading and import resolution stay here; trace collection and summaries
// run through the injected `runSource` path so `why` reproduces the same evaluation behaviour as the
// runner. Kept as a pure module (no auto-run) so both the `metta-debug` bin and the `metta` dispatcher can
// import `runDebugMain` without triggering execution on import.

import { parseArgs } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DEFAULT_FUEL, format, setOutputSink, setRawSink } from "@mettascript/core";
import { assembleQuery, compareRuns, explainCall } from "@mettascript/debug";
import { readImports } from "./file-imports";
import { runSource } from "./source";

interface Loaded {
  readonly src: string;
  readonly baseDir: string;
}

function loadProgram(source: string | undefined, file: string | undefined): Loaded {
  if (file !== undefined) {
    const p = resolve(file);
    if (!existsSync(p)) throw new Error(`file not found: ${p}`);
    return { src: readFileSync(p, "utf8"), baseDir: dirname(p) };
  }
  if (source !== undefined) return { src: source, baseDir: process.cwd() };
  throw new Error("provide --source '<metta>' or --file <path>");
}

function runQuery(
  loaded: Loaded,
  call: string,
  maxSteps: number | undefined,
): ReturnType<typeof explainCall> {
  // The point of `why`/`eval` is the trace summary and the result, not the program's own
  // `println!`/`trace!` chatter — discard it so `--llm` JSON and the human summary stay clean.
  setOutputSink(() => {});
  setRawSink(() => {});
  const program = assembleQuery(loaded.src, call);
  const imports = readImports(program, loaded.baseDir, dirname(loaded.baseDir));
  const fuel = maxSteps !== undefined && maxSteps > DEFAULT_FUEL ? maxSteps : undefined;
  return explainCall(runSource, loaded.src, call, {
    fuel,
    imports,
    runOptions: maxSteps === undefined ? undefined : { maxSteps },
  });
}

function printHuman(obj: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v)) {
      if (v.length === 0) continue;
      process.stdout.write(`${k}:\n`);
      for (const item of v) process.stdout.write(`  ${String(item)}\n`);
    } else if (v !== null && typeof v === "object") {
      const entries = Object.entries(v as Record<string, unknown>);
      if (entries.length === 0) continue;
      process.stdout.write(`${k}:\n`);
      for (const [ik, iv] of entries) process.stdout.write(`  ${ik}: ${String(iv)}\n`);
    } else {
      process.stdout.write(`${k}: ${String(v)}\n`);
    }
  }
}

function emit(llm: boolean, obj: Record<string, unknown>): void {
  if (llm) process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
  else printHuman(obj);
}

function usage(prog: string): string {
  return `${prog} — headless MeTTa engine debugger

usage:
  ${prog} (--source '<metta>' | --file <path>) why '(<call>)' [--llm] [--max-steps N]
  ${prog} (--source '<metta>' | --file <path>) eval '(<expr>)' [--llm] [--max-steps N]
  ${prog} (--source '<metta>' | --file <path>) run [--llm] [--max-steps N]
  ${prog} (--source '<metta>' | --file <path>) diff [--decline-kinds K,...] [--decline-functors F,...]
                                                    [--context N] [--hunks N] [--substantive] [--llm] [--max-steps N]

commands:
  why    run the call with the trace bus and report which grounded reducer fired, any higher-order
         specialization, any stack-overflow cut point, the reduction count, and the result.
  eval   evaluate one expression and print its result.
  run    run the whole program and print each !-query's results.
  diff   run the program twice, once as-is and once with the named compiled holders declined, and report
         the first trace event at which the two evaluations part company, plus both answers. This is how a
         compiled/interpreted disagreement is localised: --decline-kinds names holder kinds (functional,
         scalar, symbolic, imperative, rewrite, nondet, choiceUnion, pipeline), --decline-functors names
         individual functions. Declining everything and getting a different answer means the compiler is
         responsible; bisecting the list says which holder, and the trace says where. --substantive keeps
         only the hunks where both runs did something and they still differ once fresh-variable numbering
         is ignored, which drops the steps one run simply takes and the other does not.`;
}

/** The `metta debug` / `metta-debug` command. `argv` is the argument list after the debugger is selected.
 *  `prog` names the invoking command for the usage text. Throws on a usage error; the bin shim reports it
 *  and exits non-zero. */
export function runDebugMain(argv: string[], prog = "metta debug"): void {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      source: { type: "string" },
      file: { type: "string" },
      "max-steps": { type: "string" },
      "decline-kinds": { type: "string" },
      "decline-functors": { type: "string" },
      context: { type: "string" },
      hunks: { type: "string" },
      substantive: { type: "boolean", default: false },
      llm: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const cmd = positionals[0];
  if (values.help === true || cmd === undefined) {
    process.stdout.write(`${usage(prog)}\n`);
    return;
  }
  const maxSteps = values["max-steps"] !== undefined ? Number(values["max-steps"]) : undefined;
  const loaded = loadProgram(values.source, values.file);
  const llm = values.llm === true;

  if (cmd === "why") {
    const call = positionals[1];
    if (call === undefined) throw new Error(`usage: ${prog} why '(<call>)'`);
    const { result, summary: s } = runQuery(loaded, call, maxSteps);
    emit(llm, {
      call,
      result,
      grounded: s.grounded,
      specialized: s.specialized,
      overflow: s.overflow,
      reductions: s.reductions,
    });
    return;
  }
  if (cmd === "eval") {
    const expr = positionals[1];
    if (expr === undefined) throw new Error(`usage: ${prog} eval '(<expr>)'`);
    emit(llm, { result: runQuery(loaded, expr, maxSteps).result });
    return;
  }
  if (cmd === "diff") {
    const list = (v: string | undefined): string[] =>
      v === undefined || v === "" ? [] : v.split(",").map((x) => x.trim());
    const kinds = list(values["decline-kinds"]);
    const functors = list(values["decline-functors"]);
    if (kinds.length === 0 && functors.length === 0)
      throw new Error(
        `usage: ${prog} diff --decline-kinds <kinds> | --decline-functors <functors>`,
      );
    setOutputSink(() => {});
    setRawSink(() => {});
    const imports = readImports(loaded.src, loaded.baseDir, dirname(loaded.baseDir));
    const fuel = maxSteps !== undefined && maxSteps > DEFAULT_FUEL ? maxSteps : undefined;
    const base = maxSteps === undefined ? {} : { maxSteps };
    const cmp = compareRuns(
      runSource,
      loaded.src,
      { fuel, imports, runOptions: base },
      { fuel, imports, runOptions: { ...base, declineCompiled: { kinds, functors } } },
      values.context === undefined ? 6 : Number(values.context),
    );
    const shown = values.hunks === undefined ? 3 : Number(values.hunks);
    emit(llm, {
      declining: { kinds, functors },
      sameResult: cmp.sameResult,
      hunkCount: cmp.hunks.length,
      events: { asIs: cmp.leftEvents, declined: cmp.rightEvents },
      sharedTail: cmp.sharedTail,
      queriesThatDiffer: cmp.queryDiffs.length,
      firstDifferingQuery: cmp.queryDiffs
        .slice(0, 2)
        .map(
          (q) =>
            `#${q.index} ${q.query}\n  as-is:    ${q.left.join(" | ")}\n  declined: ${q.right.join(" | ")}`,
        ),
      substantiveHunks: cmp.hunks.filter((h) => h.substantive).length,
      hunks: (values.substantive === true ? cmp.hunks.filter((h) => h.substantive) : cmp.hunks)
        .slice(0, shown)
        .map((h) =>
          [
            `@ as-is ${h.leftAt}, declined ${h.rightAt}`,
            ...h.left.map((x) => `  as-is only: ${x}`),
            ...h.right.map((x) => `  declined only: ${x}`),
          ].join("\n"),
        ),
      asIsResult: cmp.leftResult,
      declinedResult: cmp.rightResult,
    });
    return;
  }
  if (cmd === "run") {
    const imports = readImports(loaded.src, loaded.baseDir, dirname(loaded.baseDir));
    const fuel = maxSteps !== undefined && maxSteps > DEFAULT_FUEL ? maxSteps : undefined;
    const results = runSource(
      loaded.src,
      fuel,
      imports,
      maxSteps === undefined ? undefined : { maxSteps },
    ).map((g) => g.results.map(format));
    emit(llm, { results });
    return;
  }
  throw new Error(`unknown command '${cmd}'\n\n${usage(prog)}`);
}
