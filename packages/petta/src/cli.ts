#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: the petta command, PeTTa's run.sh and main.pl over the TypeScript engine: leading .metta arguments
// are files loaded in order, the rest flags (--silent, --strict, --strict-det); results print after the whole
// load; halt/1 sets the exit status, an uncaught error prints SWI's "ERROR:" report and exits 2.
// am[implements a-pe-loader-cli]

import { writeSync } from "node:fs";
import { Petta } from "./engine";
import { errorMessage } from "./messages";
import { Halt, PrologError } from "./terms";

/** main.pl metta_files/2: leading .metta arguments, else the first argument. */
function mettaFiles(args: string[]): string[] {
  const files: string[] = [];
  for (const a of args) {
    if (a.endsWith(".metta")) files.push(a);
    else break;
  }
  if (files.length > 0) return files;
  return args.length > 0 && !["silent", "--silent", "-s"].includes(args[0]!) ? [args[0]!] : [];
}

function write(fd: number, s: string): void {
  let buf = Buffer.from(s, "utf8");
  while (buf.length > 0) {
    try {
      const n = writeSync(fd, buf);
      buf = buf.subarray(n);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EAGAIN") continue;
      throw e;
    }
  }
}

function main(): number {
  const args = process.argv.slice(2);
  const petta = new Petta({ argv: args, out: (s) => write(1, s), err: (s) => write(2, s) });
  const files = mettaFiles(args.filter((a) => !["silent", "--silent", "-s"].includes(a)));
  try {
    petta.runMain(files);
    return 0;
  } catch (e) {
    if (e instanceof Halt) return e.status;
    if (e instanceof PrologError) {
      write(2, "ERROR: " + errorMessage(e.ball, files[0] ?? "") + "\n");
      return 2;
    }
    if (e instanceof RangeError) {
      write(2, "ERROR: Stack limit exceeded\n");
      return 2;
    }
    throw e;
  }
}

process.exitCode = main();
