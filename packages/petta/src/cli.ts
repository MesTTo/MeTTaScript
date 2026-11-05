#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: the petta command, PeTTa's run.sh: the arguments become the argv flag that PeTTa's own main.pl reads
// (leading .metta files loaded in order, then flags such as --silent, --strict, --strict-det), and the hosted
// engine runs main/0; halt/1 sets the exit status, an uncaught error prints SWI's "ERROR:" report and exits 2.
// The engine runs in a worker thread whose stack is sized for deep terms, as SWI's stacks are (run.sh gives 8 GB);
// only the worker loads the engine.
// am[implements a-hp-entry]

import { writeSync } from "node:fs";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

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

async function run(args: string[]): Promise<number> {
  // am[implements a-petta-speed-1105.startup.worker]
  const { HostedPetta } = await import("./hosted");
  try {
    return new HostedPetta({ argv: args, out: (s) => write(1, s), err: (s) => write(2, s) }).run();
  } catch (e) {
    if (e instanceof RangeError) {
      write(2, "ERROR: Stack limit exceeded\n");
      return 2;
    }
    throw e;
  }
}

if (isMainThread) {
  // Stack and heap limits for the engine thread: deep MeTTa terms recurse in printing, copying and comparing. The young
  // generation is capped at V8's size for an 8 MB semi-space, half its default: small runs peak about 25 MB lower
  // (fib 190 to 164 MB, hyperpose_primes 203 to 178 MB) at no measured cost in time, where a 4 MB one cost roman_test
  // 42% (c-young-gen-cap).
  // am[implements a-petta-speed-1105.memory.young-gen]
  const worker = new Worker(new URL(import.meta.url), {
    workerData: process.argv.slice(2),
    resourceLimits: { stackSizeMb: 1024, maxOldGenerationSizeMb: 16384, maxYoungGenerationSizeMb: 24 },
  });
  worker.on("message", (status: number) => {
    process.exitCode = status;
  });
  worker.on("error", (e) => {
    write(2, "ERROR: " + (e instanceof Error ? e.message : String(e)) + "\n");
    process.exitCode = 2;
  });
} else {
  parentPort!.postMessage(await run(workerData as string[]));
}
