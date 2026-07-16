// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Async executable grounded heads: a grounded atom's `exec` may return Promise<Atom[]>. The async
// driver awaits it, the sync driver refuses it (AsyncInSyncError), and a rejection becomes an
// (Error ...) atom. The existing synchronous exec path is unchanged. This backs the py-atom surface
// (an applicable Python callable), but is tested here in isolation at the core boundary.
import { describe, it, expect } from "vitest";
import { gnd, sym, expr, gint, type Atom, type GroundedExec } from "./atom";
import { format } from "./parser";
import { buildEnv, mettaEval, mettaEvalAsync, initSt } from "./eval";
import { stdlibAtoms } from "./stdlib";
import { stdTable } from "./builtins";
import { DEFAULT_FUEL, preludeAtoms } from "./runner";

const env = () => buildEnv([...preludeAtoms(), ...stdlibAtoms()], stdTable());

/** A grounded atom whose exec is `fn`; usable as an expression head `(<atom> arg...)`. */
const opAtom = (id: string, fn: GroundedExec): Atom =>
  gnd({ g: "ext", kind: "operation", id }, sym("%Undefined%"), fn);

const results = async (head: Atom): Promise<string[]> => {
  const [pairs] = await mettaEvalAsync(env(), DEFAULT_FUEL, initSt(), [], expr([head, gint(21n)]));
  return pairs.map(([a]) => format(a));
};

describe("async grounded-head exec", () => {
  it("async exec resolving: results flow through the async driver", async () => {
    const head = opAtom("async-ok", () => Promise.resolve([sym("alpha"), sym("beta")]));
    expect(await results(head)).toEqual(["alpha", "beta"]);
  });

  it("async exec rejecting: becomes a single (Error ...) atom", async () => {
    const head = opAtom("async-boom", () => Promise.reject(new Error("kaboom")));
    const r = await results(head);
    expect(r).toHaveLength(1);
    expect(r[0]).toContain("Error");
    expect(r[0]).toContain("kaboom");
  });

  it("a sync exec still works identically on the async driver", async () => {
    const head = opAtom("sync-ok", () => [sym("gamma")]);
    expect(await results(head)).toEqual(["gamma"]);
  });

  it("a sync exec still works on the sync driver (no regression)", () => {
    const head = opAtom("sync-ok2", () => [sym("delta")]);
    const [pairs] = mettaEval(env(), DEFAULT_FUEL, initSt(), [], expr([head, gint(21n)]));
    expect(pairs.map(([a]) => format(a))).toEqual(["delta"]);
  });

  it("an async exec reached by the sync driver throws AsyncInSyncError", () => {
    const head = opAtom("async-sync", () => Promise.resolve([sym("x")]));
    expect(() => mettaEval(env(), DEFAULT_FUEL, initSt(), [], expr([head, gint(21n)]))).toThrow(
      /synchronous evaluation/,
    );
  });

  it("passes a selected metta context to an async executable head", async () => {
    const runtime = env();
    const head = opAtom("async-context", async (_args, context) => {
      if (context === undefined) throw new Error("missing grounded call context");
      return [context.currentSpace];
    });
    const [, allocated] = mettaEval(runtime, DEFAULT_FUEL, initSt(), [], expr([sym("new-space")]));
    const [pairs] = await mettaEvalAsync(
      runtime,
      DEFAULT_FUEL,
      allocated,
      [],
      expr([sym("metta"), expr([head]), sym("%Undefined%"), sym("&space-0")]),
    );

    expect(pairs.map(([atom]) => format(atom))).toEqual(["&space-0"]);
  });
});
