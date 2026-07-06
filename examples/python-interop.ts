// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Python interop: a MeTTa program calling into CPython through @metta-ts/py. Python runs in a separate
// process and MeTTa talks to it over IPC, so the interpreter stays pure TypeScript. The ops are async
// (a call crosses a process boundary), so you run with `runAsync` and pass in a bridge yourself.
//
// Run it (after `pnpm build`, and with python3 on your PATH): npx tsx examples/python-interop.ts
import { MeTTa } from "@metta-ts/hyperon";
import { registerPyInterop, pythoniaBridge } from "@metta-ts/py";
import { python } from "pythonia";

const m = new MeTTa();
const bridge = pythoniaBridge(python);
registerPyInterop(m, bridge);

const run1 = async (q: string): Promise<string[]> =>
  (await m.runAsync(q))[0]!.map((a) => a.toString());

// py-call dispatches on the head: a builtin, a module function, or a `.method` on a live object.
console.log("abs(-5):", await run1(`!(py-call (abs -5))`)); // [ '5' ]
console.log("math.gcd(12, 18):", await run1(`!(py-call (math.gcd 12 18))`)); // [ '6' ]

// py-eval evaluates a Python expression string; a returned list converts to a MeTTa expression.
console.log("2 ** 10:", await run1(`!(py-eval "2 ** 10")`)); // [ '1024' ]
console.log("a list:", await run1(`!(py-eval "[1, 2.5, 'x', True, None]")`)); // [ '(1 2.5 x (@ true) (@ none))' ]

// True/False/None come back as (@ true)/(@ false)/(@ none), kept distinct from MeTTa symbols.
console.log("bool(1):", await run1(`!(py-call (bool 1))`)); // [ '(@ true)' ]

// A non-primitive result stays a live handle you keep passing around.
console.log("Fraction 1/3:", await run1(`!(py-call (str (py-call (fractions.Fraction 1 3))))`)); // [ '1/3' ]

// The py-atom family is Hyperon's surface over the same bridge: resolve a path into an atom you apply.
console.log("operator.add:", await run1(`!((py-atom operator.add) 40 2)`)); // [ '42' ]
console.log("math.pi:", await run1(`!(py-atom math.pi)`)); // [ '3.141592653589793' ]

// Errors do not crash the run. A raised Python exception (here ZeroDivisionError) and an unresolvable
// path both come back as an (Error ...) atom the program can inspect, and evaluation continues. This is
// a deliberate divergence from PeTTa, which aborts on a Python error.
console.log("1 / 0:", await run1(`!(py-eval "1 / 0")`)); // [ '(Error ... ZeroDivisionError: division by zero)' ]
console.log("bad path:", await run1(`!(py-atom nosuch.module)`)); // [ '(Error ... AttributeError: ... no attribute ...)' ]

await bridge.dispose(); // stops the Python subprocess so the process can exit
