// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

import { describe, it, expect } from "vitest";
import { runProgramAsync, preludeAtoms } from "./runner";
import { format } from "./parser";
import { emptyExpr, gint, sym, expr, type Atom } from "./atom";
import { type AsyncGroundFn, AsyncInSyncError, buildEnv, initSt, mettaEval } from "./eval";
import { stdlibAtoms } from "./stdlib";
import { stdTable } from "./builtins";

// An async grounded op that doubles its argument after an actual await (simulated I/O).
const fetchDouble: AsyncGroundFn = async (args) => {
  await new Promise((r) => setTimeout(r, 1));
  const a = args[0]!;
  return {
    tag: "ok",
    results: [gint((a.kind === "gnd" && a.value.g === "int" ? Number(a.value.n) : 0) * 2)],
  };
};
const ops = new Map<string, AsyncGroundFn>([["fetch-double", fetchDouble]]);
const r1 = async (src: string): Promise<string[]> => {
  const rs = await runProgramAsync(src, ops);
  return rs[rs.length - 1]!.results.map(format);
};

describe("async evaluation (generator dual-driver)", () => {
  it("awaits a top-level async grounded op", async () => {
    expect(await r1("!(fetch-double 21)")).toEqual(["42"]);
  });

  it("suspends through sync evaluation: async op nested inside arithmetic", async () => {
    expect(await r1("!(+ 1 (fetch-double 20))")).toEqual(["41"]);
  });

  it("composes with control flow: async op in a conditional (only the taken branch)", async () => {
    expect(await r1("!(if (> (fetch-double 5) 8) yes no)")).toEqual(["yes"]);
  });

  it("composes with nondeterminism", async () => {
    expect(
      (
        await runProgramAsync("!(collapse (fetch-double (superpose (1 2 3))))", ops)
      )[0]!.results.map(format),
    ).toEqual(["(2 4 6)"]);
  });

  it("a pure program gives the same result via the async runner", async () => {
    expect(await r1("!(+ 1 2)")).toEqual(["3"]);
  });

  it("the sync driver throws AsyncInSyncError when it reaches an async op", () => {
    const env = buildEnv([...preludeAtoms(), ...stdlibAtoms()], stdTable());
    env.agt.set("fetch-double", fetchDouble);
    const q: Atom = expr([sym("fetch-double"), gint(3)]);
    expect(() => mettaEval(env, 100_000, initSt(), [], q)).toThrow(AsyncInSyncError);
  });

  it("applies addAtom effects to &self before the next query", async () => {
    const installRule: AsyncGroundFn = async () => ({
      tag: "ok",
      results: [emptyExpr],
      effects: [
        {
          kind: "addAtom",
          space: sym("&self"),
          atom: expr([sym("="), expr([sym("async-installed")]), sym("ok")]),
        },
      ],
    });
    const rs = await runProgramAsync(
      "!(install-rule)\n!(async-installed)",
      new Map([["install-rule", installRule]]),
    );
    expect(rs[0]!.results.map(format)).toEqual(["()"]);
    expect(rs[1]!.results.map(format)).toEqual(["ok"]);
  });

  it("applies effects even when the async op returns no results", async () => {
    const installRule: AsyncGroundFn = async () => ({
      tag: "ok",
      results: [],
      effects: [
        {
          kind: "addAtom",
          space: sym("&self"),
          atom: expr([sym("="), expr([sym("silent-installed")]), sym("ok")]),
        },
      ],
    });
    const rs = await runProgramAsync(
      "!(silent-install)\n!(silent-installed)",
      new Map([["silent-install", installRule]]),
    );
    expect(rs[0]!.results.map(format)).toEqual([]);
    expect(rs[1]!.results.map(format)).toEqual(["ok"]);
  });

  it("applies addAtom effects to token-bound named spaces", async () => {
    const addFact: AsyncGroundFn = async () => ({
      tag: "ok",
      results: [emptyExpr],
      effects: [
        { kind: "addAtom", space: sym("&s"), atom: expr([sym("edge"), sym("a"), sym("b")]) },
      ],
    });
    const rs = await runProgramAsync(
      "!(bind! &s (new-space))\n!(add-named-fact)\n!(match &s (edge a $x) $x)",
      new Map([["add-named-fact", addFact]]),
    );
    expect(rs[2]!.results.map(format)).toEqual(["b"]);
  });

  it("applies removeAtom effects through the same space path", async () => {
    const removeFact: AsyncGroundFn = async () => ({
      tag: "ok",
      results: [emptyExpr],
      effects: [
        { kind: "addAtom", space: sym("&self"), atom: expr([sym("target"), sym("gone")]) },
        { kind: "removeAtom", space: sym("&self"), atom: expr([sym("target"), sym("gone")]) },
      ],
    });
    const rs = await runProgramAsync(
      "!(remove-target)\n!(match &self (target $x) $x)",
      new Map([["remove-target", removeFact]]),
    );
    expect(rs[1]!.results.map(format)).toEqual([]);
  });

  it("applies bindToken effects", async () => {
    const bindAnswer: AsyncGroundFn = async () => ({
      tag: "ok",
      results: [emptyExpr],
      effects: [{ kind: "bindToken", name: "answer", atom: gint(41) }],
    });
    const rs = await runProgramAsync(
      "!(bind-answer)\n!(+ answer 1)",
      new Map([["bind-answer", bindAnswer]]),
    );
    expect(rs[1]!.results.map(format)).toEqual(["42"]);
  });

  it("awaits host import hooks through import!", async () => {
    const rs = await runProgramAsync(
      '!(import! &self "native.mod")\n!(native-answer)',
      new Map(),
      100_000,
      new Map(),
      {
        hostImport: async (space, file) => {
          expect(format(space)).toBe("&self");
          expect(format(file)).toBe('"native.mod"');
          await Promise.resolve();
          return {
            tag: "ok",
            results: [emptyExpr],
            effects: [
              {
                kind: "addAtom",
                space,
                atom: expr([sym("="), expr([sym("native-answer")]), gint(42)]),
              },
            ],
          };
        },
      },
    );
    expect(rs[0]!.results.map(format)).toEqual(["()"]);
    expect(rs[1]!.results.map(format)).toEqual(["42"]);
  });

  it("turns host import runtime errors into Error atoms", async () => {
    const rs = await runProgramAsync(
      '!(import! &self "missing.mod")',
      new Map(),
      100_000,
      new Map(),
      {
        hostImport: () => ({ tag: "runtimeError", msg: "missing" }),
      },
    );
    expect(rs[0]!.results.map(format)).toEqual(['(Error (import! &self "missing.mod") missing)']);
  });

  it("turns invalid effects into an Error atom", async () => {
    const badEffect: AsyncGroundFn = async () => ({
      tag: "ok",
      results: [sym("unreachable")],
      effects: [
        {
          kind: "addAtom",
          space: expr([sym("not-a-space")]),
          atom: expr([sym("bad"), sym("fact")]),
        },
      ],
    });
    const rs = await runProgramAsync("!(bad-effect)", new Map([["bad-effect", badEffect]]));
    expect(rs[0]!.results.map(format)[0]).toContain("Error");
    expect(rs[0]!.results.map(format)[0]).toContain("not a space");
  });
});
