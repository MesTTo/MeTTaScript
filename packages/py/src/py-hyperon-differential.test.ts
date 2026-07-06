// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Differential oracle for the py-atom family: the same expressions through pip `hyperon` (the
// reference implementation of this surface) and through @metta-ts/py + pythonia, asserting identical
// results. The corpus is numeric on purpose: our marshalling follows PeTTa/janus (str -> Symbol,
// list -> handle) while hyperon wraps results in its own grounded objects, so the two agree only
// where the representation is shared, i.e. numbers. What this proves is the part that MUST match
// across engines: dotted-path RESOLUTION (import longest prefix + getattr walk) and callable
// APPLICATION. Gated on HYPERON_LIVE=1 with a hyperon venv at .venv-hyperon (override HYPERON_PY);
// set one up with `uv venv --python 3.11 .venv-hyperon && uv pip install -p .venv-hyperon hyperon`.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { MeTTa } from "@metta-ts/hyperon";
import { registerPyInterop, type PyBridge } from "./index";
import { makePythoniaBridge } from "./live-bridge";

const here = dirname(fileURLToPath(import.meta.url));
const VENV_PY =
  process.env.HYPERON_PY ?? join(here, "..", "..", "..", ".venv-hyperon", "bin", "python");
const LIVE = process.env.HYPERON_LIVE === "1" && existsSync(VENV_PY);
const d = LIVE ? describe : describe.skip;

// Each entry is one MeTTa expression whose final result is a number, so PeTTa-style and
// hyperon-style marshalling coincide. Composition, module functions, builtins, py-list/py-tuple,
// and py-dot on a live object are all covered.
const CORPUS = [
  "((py-atom operator.add) 40 2)",
  "((py-atom operator.sub) 100 58)",
  "((py-atom operator.mul) 6 7)",
  "(py-atom math.pi)",
  "(py-atom math.tau)",
  "((py-atom math.gcd) 12 18)",
  "((py-atom abs) -5)",
  "((py-atom len) (py-list (1 2 3)))",
  "((py-atom len) (py-tuple (1 2 3 4)))",
  "((py-atom max) (py-list (3 7 2)))",
  "(py-dot ((py-atom fractions.Fraction) 6 4) numerator)",
  "((py-atom operator.add) ((py-atom operator.mul) 6 7) 0)",
];

/** Run the whole corpus through pip hyperon in one subprocess; returns each expression's results. */
function runHyperonAll(exprs: string[]): string[][] {
  const script = [
    "import json",
    "from hyperon import MeTTa",
    `EXPRS = json.loads(${JSON.stringify(JSON.stringify(exprs))})`,
    "out = []",
    "for e in EXPRS:",
    "    rs = MeTTa().run('!' + e)",
    "    out.append([str(a) for group in rs for a in group])",
    "print('JSONOUT:' + json.dumps(out))",
  ].join("\n");
  const raw = execFileSync(VENV_PY, ["-c", script], { timeout: 120_000 }).toString();
  const line = raw.split("\n").find((l) => l.startsWith("JSONOUT:"));
  if (line === undefined) throw new Error(`hyperon produced no JSONOUT line:\n${raw}`);
  return JSON.parse(line.slice("JSONOUT:".length)) as string[][];
}

d("differential vs hyperon (py-atom family, numeric surface)", () => {
  let bridge: PyBridge;
  let m: MeTTa;
  let hyperon: string[][];

  beforeAll(async () => {
    bridge = await makePythoniaBridge();
    m = new MeTTa();
    registerPyInterop(m, bridge);
    hyperon = runHyperonAll(CORPUS);
  });
  afterAll(async () => {
    await bridge.dispose();
  });

  CORPUS.forEach((expr, i) => {
    it(`matches hyperon: ${expr}`, async () => {
      const ours = (await m.runAsync("!" + expr))[0]!.map((a) => a.toString());
      expect(ours).toEqual(hyperon[i]);
    });
  });
});
