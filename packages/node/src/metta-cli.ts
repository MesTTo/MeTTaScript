#!/usr/bin/env node

// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// The unified `metta` CLI: a git-style dispatcher over the runner, checker, debugger, and grapher. Each
// subcommand's logic is imported lazily so `metta run` never loads the debugger or the grapher, matching
// the lean `metta-ts` startup. `metta-ts` and `metta-debug` stay as compatibility aliases (thin bins over
// the same shared modules).

import { createRequire } from "node:module";

function version(): string {
  const require = createRequire(import.meta.url);
  return (require("../package.json") as { version: string }).version;
}

const HELP = `metta — MeTTaScript command-line interface

usage:
  metta <file.metta> [options]         run a program (shorthand for "metta run")
  metta run <file.metta> [options]     run a program, printing each !-query's results
  metta check <file.metta> [options]   statically analyze a program (--json, --undefined-symbols)
  metta debug (--file <p> | --source '<m>') <why|eval|run> [--llm]   debug the engine
  metta graph <file.metta> [-o out.gif] [--view blocks|graph|side-by-side]   render a reduction GIF
  metta fuzz <file.metta> [--exhaustive] [--json]   run declared (FuzzTest ...) properties
  metta reach <file.metta> [id]         run declared (FuzzReachTest ...) searches
  metta --version | --help

Run "metta run --help" style is not needed; each subcommand prints its own usage on a missing argument.
"metta-ts" and "metta-debug" remain as aliases.`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const first = args[0];

  if (first === undefined || first === "--help" || first === "-h" || first === "help") {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  if (first === "--version" || first === "-v") {
    process.stdout.write(`${version()}\n`);
    return;
  }

  const rest = args.slice(1);
  switch (first) {
    case "run": {
      const { runCliMain } = await import("./run-main");
      await runCliMain(rest, "metta run");
      return;
    }
    case "check": {
      const { runCliMain } = await import("./run-main");
      await runCliMain(["--check", ...rest], "metta check");
      return;
    }
    case "debug": {
      const { runDebugMain } = await import("./debug-main");
      runDebugMain(rest, "metta debug");
      return;
    }
    case "graph": {
      const { runGraphMain } = await import("./graph-main");
      await runGraphMain(rest);
      return;
    }
    case "fuzz":
    case "reach": {
      const { runFuzzMain } = await import("./fuzz-main");
      const code = runFuzzMain(rest, first);
      if (code !== 0) process.exit(code);
      return;
    }
    default: {
      // Shorthand: `metta <file>` runs the file, and any leading flag (e.g. `metta --check x.metta`)
      // falls through to the runner, matching `metta-ts`'s single-command behavior.
      const { runCliMain } = await import("./run-main");
      await runCliMain(args, "metta");
      return;
    }
  }
}

main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
