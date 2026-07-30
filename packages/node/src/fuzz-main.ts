// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// `metta fuzz` and `metta reach`: run the declarations a file carries, not the file's own queries.
//
// A suite file declares tests as data (`FuzzTest`, `FuzzReachTest`). The CLI loads the file's
// declarations, drops its `!` directives, and evaluates its own query instead. Dropping them is the
// point: reading a suite must not execute whatever else the file would have run, so discovery cannot
// be a side channel for arbitrary evaluation. `import!` and `register-module!` are the exception,
// because a property defined in an imported file is undefined without them.
//
// Command-line settings become normalized MeTTa config options and are merged into each declaration's
// own config by replacement, so `--seed 7` overrides one option and leaves the rest of the
// declaration intact.

import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  DEFAULT_FUEL,
  evalSequential,
  format,
  parseAll,
  standardTokenizer,
  type Atom,
  type QueryResult,
  type TopAtom,
} from "@mettascript/core";
import {
  decodeFuzzOutcome,
  exitCodeForOutcomes,
  renderOutcomeLine,
  FUZZ_EXIT_INVALID,
  type FuzzExitCode,
  type FuzzOutcome,
} from "@mettascript/fuzz";
import { readImports } from "./file-imports";

const USAGE = `usage:
  metta fuzz <file.metta> [options]      run every (FuzzTest ...) declaration
  metta fuzz --exhaustive <file.metta>   enumerate each declaration's whole domain
  metta reach <file.metta> [id]          run every (FuzzReachTest ...) declaration, or one by id

options:
  --seed <n>              --runs <n>              --max-size <n>
  --max-discards <n>      --max-shrinks <n>       --case-steps <n>
  --case-depth <n>        --max-enumerated <n>    --max-depth <n>
  --max-states <n>        --max-transitions <n>
  --json                  print the full result atoms as JSON
  --list                  list declared tests without running them

exit codes:
  0 pass or definitive answer   1 property failure
  2 invalid input or data       3 incomplete run (gave up, bounded, or cut off)`;

/** A CLI flag and the MeTTa config option it sets. */
const FUZZ_OPTIONS: ReadonlyMap<string, string> = new Map([
  ["--seed", "Seed"],
  ["--runs", "Runs"],
  ["--max-size", "MaxSize"],
  ["--max-discards", "MaxDiscards"],
  ["--max-shrinks", "MaxShrinks"],
  ["--case-steps", "CaseSteps"],
  ["--case-depth", "CaseDepth"],
  ["--max-enumerated", "MaxEnumerated"],
]);

const REACH_OPTIONS: ReadonlyMap<string, string> = new Map([
  ["--max-depth", "MaxDepth"],
  ["--max-states", "MaxStates"],
  ["--max-transitions", "MaxTransitions"],
]);

export interface FuzzCliRequest {
  readonly file: string;
  readonly overrides: readonly string[];
  readonly exhaustive: boolean;
  readonly json: boolean;
  readonly list: boolean;
  /** `metta reach <file> <id>` restricts the run to one declaration. */
  readonly only: string | undefined;
}

export type FuzzCliParse =
  | { readonly ok: true; readonly request: FuzzCliRequest }
  | { readonly ok: false; readonly message: string };

/** Parse arguments for one of the two subcommands. Unknown flags are refused rather than ignored. */
export function parseFuzzArgs(args: readonly string[], mode: "fuzz" | "reach"): FuzzCliParse {
  const known = mode === "reach" ? REACH_OPTIONS : FUZZ_OPTIONS;
  const overrides: string[] = [];
  let file: string | undefined;
  let only: string | undefined;
  let exhaustive = false;
  let json = false;
  let list = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--exhaustive") {
      if (mode === "reach") return { ok: false, message: "--exhaustive applies to metta fuzz" };
      exhaustive = true;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--list") {
      list = true;
    } else if (known.has(arg)) {
      const raw = args[i + 1];
      if (raw === undefined) return { ok: false, message: `${arg} needs a value` };
      if (!/^\d+$/.test(raw)) return { ok: false, message: `${arg} needs a nonnegative integer` };
      overrides.push(`(${known.get(arg)!} ${raw})`);
      i += 1;
    } else if (arg.startsWith("-")) {
      return { ok: false, message: `unknown option ${arg}` };
    } else if (file === undefined) {
      file = arg;
    } else if (mode === "reach" && only === undefined) {
      only = arg;
    } else {
      return { ok: false, message: `unexpected argument ${arg}` };
    }
  }

  if (file === undefined) return { ok: false, message: "a .metta file is required" };
  return { ok: true, request: { file, overrides, exhaustive, json, list, only } };
}

// Loading a module is part of declaring a suite, so these directives are kept while every other one
// is dropped. A property defined in an imported file is undefined without them.
const MODULE_DIRECTIVES: ReadonlySet<string> = new Set(["import!", "register-module!"]);

function isModuleDirective(atom: Atom): boolean {
  if (atom.kind !== "expr") return false;
  const head = atom.items[0];
  return head?.kind === "sym" && MODULE_DIRECTIVES.has(head.name);
}

/** The declarations of a source file, with every `!` directive except module loading removed. */
function declarationsOf(src: string): TopAtom[] {
  return parseAll(src, standardTokenizer()).filter(
    (top) => !top.bang || isModuleDirective(top.atom),
  );
}

/** Results of evaluating one appended query against a file's declarations. */
function evaluate(src: string, file: string, query: string): QueryResult[] {
  const fileDir = dirname(resolve(file));
  const imports = readImports(src, fileDir, dirname(fileDir));
  // `import! &self fuzz` is appended rather than required in the file, so a suite file needs no
  // ceremony; importing twice is a no-op.
  const appended = parseAll(`!(import! &self fuzz)\n!${query}`, standardTokenizer());
  const program = [...declarationsOf(src), ...appended];
  return evalSequential(program, DEFAULT_FUEL, imports, { tabling: true });
}

/** Each `(FuzzSuiteResult id result)` pair of a suite run, in declaration order. */
function suiteResults(atom: Atom): readonly { readonly id: string; readonly result: Atom }[] {
  if (atom.kind !== "expr") return [];
  const pairs: { id: string; result: Atom }[] = [];
  for (const item of atom.items) {
    if (
      item.kind !== "expr" ||
      item.items.length !== 3 ||
      item.items[0]?.kind !== "sym" ||
      (item.items[0] as { name: string }).name !== "FuzzSuiteResult"
    )
      continue;
    const id = item.items[1]!;
    pairs.push({ id: id.kind === "sym" ? id.name : format(id), result: item.items[2]! });
  }
  return pairs;
}

export interface FuzzCliOutcome {
  readonly code: FuzzCliExit;
  readonly lines: readonly string[];
}

type FuzzCliExit = FuzzExitCode;

/** Run one request and return what to print plus the exit code, without touching the process. */
export function runFuzzRequest(request: FuzzCliRequest, mode: "fuzz" | "reach"): FuzzCliOutcome {
  if (!existsSync(request.file))
    return { code: FUZZ_EXIT_INVALID, lines: [`no such file: ${request.file}`] };
  const src = readFileSync(request.file, "utf8");

  const overrides = `(${request.overrides.join(" ")})`;
  const query = request.list
    ? mode === "reach"
      ? "(fuzz-reach-suite-tests)"
      : "(fuzz-suite-tests)"
    : mode === "reach"
      ? `(fuzz-run-reach-suite-with ${overrides})`
      : request.exhaustive
        ? `(fuzz-run-suite-exhaustive ${overrides})`
        : `(fuzz-run-suite-with ${overrides})`;

  const results = evaluate(src, request.file, query);
  const last = results.at(-1);
  if (last === undefined || last.results.length !== 1)
    return {
      code: FUZZ_EXIT_INVALID,
      lines: [`the suite query produced ${last?.results.length ?? 0} results, expected one`],
    };
  const value = last.results[0]!;

  if (request.list)
    return {
      code: 0,
      lines: value.kind === "expr" ? value.items.map((item) => format(item)) : [format(value)],
    };

  const pairs = suiteResults(value);
  if (pairs.length === 0) {
    const what = mode === "reach" ? "(FuzzReachTest ...)" : "(FuzzTest ...)";
    return { code: 0, lines: [`no ${what} declarations in ${request.file}`] };
  }

  const selected =
    request.only === undefined ? pairs : pairs.filter((pair) => pair.id === request.only);
  if (selected.length === 0)
    return { code: FUZZ_EXIT_INVALID, lines: [`no declaration named ${request.only!}`] };

  const outcomes: FuzzOutcome[] = selected.map((pair) => decodeFuzzOutcome(pair.result));
  const lines = request.json
    ? [
        JSON.stringify(
          selected.map((pair, i) => ({
            id: pair.id,
            kind: outcomes[i]!.kind,
            result: format(pair.result),
          })),
        ),
      ]
    : outcomes.map(renderOutcomeLine);
  return { code: exitCodeForOutcomes(outcomes), lines };
}

/** CLI entry. Writes to stdout/stderr and returns the exit code. */
export function runFuzzMain(args: readonly string[], mode: "fuzz" | "reach"): FuzzCliExit {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const parsed = parseFuzzArgs(args, mode);
  if (!parsed.ok) {
    process.stderr.write(`${parsed.message}\n\n${USAGE}\n`);
    return FUZZ_EXIT_INVALID;
  }
  const outcome = runFuzzRequest(parsed.request, mode);
  for (const line of outcome.lines) process.stdout.write(`${line}\n`);
  return outcome.code;
}
