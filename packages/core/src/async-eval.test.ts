// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

import { describe, it, expect, vi } from "vitest";
import { runProgramAsync, preludeAtoms, standardTokenizer } from "./runner";
import { format, parseAll } from "./parser";
import { emptyExpr, gint, sym, expr, type Atom } from "./atom";
import {
  addAtomToEnv,
  type AsyncGroundFn,
  AsyncInSyncError,
  buildEnv,
  createAsyncEvaluationSession,
  initSt,
  mettaEval,
  mettaEvalAsync,
  registerAsyncGroundedOperation,
  registerGroundedOperation,
} from "./eval";
import { stdlibAtoms } from "./stdlib";
import { type GroundedCallContext, stdTable } from "./builtins";

// An async grounded op that doubles its argument after an actual await (simulated I/O).
const fetchDouble: AsyncGroundFn = async (args) => {
  await new Promise((r) => setTimeout(r, 1));
  const a = args[0]!;
  return {
    tag: "ok",
    results: [gint((a.kind === "gnd" && a.value.g === "int" ? Number(a.value.n) : 0) * 2)],
  };
};
const whereAmI: AsyncGroundFn = async (_args, context) => {
  if (context === undefined) throw new Error("missing grounded call context");
  return { tag: "ok", results: [context.currentSpace] };
};
const ops = new Map<string, AsyncGroundFn>([["fetch-double", fetchDouble]]);
const r1 = async (src: string): Promise<string[]> => {
  const rs = await runProgramAsync(src, ops);
  return rs[rs.length - 1]!.results.map(format);
};
const parsedAtom = (source: string): Atom => parseAll(`!${source}`, standardTokenizer())[0]!.atom;
const deferred = (): { readonly promise: Promise<void>; readonly resolve: () => void } => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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
    ).toEqual(["(, 2 4 6)"]);
  });

  it("a pure program gives the same result via the async runner", async () => {
    expect(await r1("!(+ 1 2)")).toEqual(["3"]);
  });

  it("keeps concurrent runners isolated while sharing the cached base program", async () => {
    const [left, right] = await Promise.all([
      runProgramAsync("(= (async-local) left)\n!(async-local)"),
      runProgramAsync("(= (async-local) right)\n!(async-local)"),
    ]);
    const untouched = await runProgramAsync("!(async-local)");

    expect(left[0]!.results.map(format)).toEqual(["left"]);
    expect(right[0]!.results.map(format)).toEqual(["right"]);
    expect(untouched[0]!.results.map(format)).toEqual(["(async-local)"]);
  });

  it("loads a definition between async queries", async () => {
    const results = await runProgramAsync("!(+ 1 2)\n(= (later) ok)\n!(later)");

    expect(results.map((result) => result.results.map(format))).toEqual([["3"], ["ok"]]);
  });

  it("passes the selected metta context to async grounded operations", async () => {
    const rs = await runProgramAsync(
      `
        !(bind! &s (new-space))
        !(metta (where-am-i) %Undefined% &s)
      `,
      new Map([["where-am-i", whereAmI]]),
    );

    expect(rs[1]!.results.map(format)).toEqual(["&space-0"]);
  });

  it("keeps evalc context through a named rule and async grounding", async () => {
    const rs = await runProgramAsync(
      `
        !(bind! &s (new-space))
        !(add-atom &s (= (inside) (function (chain (eval (where-am-i)) $space (return $space)))))
        !(evalc (inside) &s)
      `,
      new Map([["where-am-i", whereAmI]]),
    );

    expect(rs[2]!.results.map(format)).toEqual(["&space-0"]);
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

  it("makes type declarations from grounded effects visible to later queries", async () => {
    const installType: AsyncGroundFn = async () => ({
      tag: "ok",
      results: [emptyExpr],
      effects: [
        {
          kind: "addAtom",
          space: sym("&self"),
          atom: expr([sym(":"), sym("host-value"), sym("HostType")]),
        },
      ],
    });
    const rs = await runProgramAsync(
      "!(install-type)\n!(get-type host-value)",
      new Map([["install-type", installType]]),
    );

    expect(rs[1]!.results.map(format)).toEqual(["HostType"]);
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

  it("passes a named metta context through host imports and their effects", async () => {
    const rs = await runProgramAsync(
      `
        !(bind! &s (new-space))
        !(metta (import! &self "native.mod") %Undefined% &s)
        !(metta (native-answer) %Undefined% &s)
        !(native-answer)
      `,
      new Map(),
      100_000,
      new Map(),
      {
        hostImport: async (space, _file, context) => {
          expect(format(space)).toBe("&space-0");
          expect(context).toBeDefined();
          expect(format(context!.currentSpace)).toBe("&space-0");
          return {
            tag: "ok",
            results: [emptyExpr],
            effects: [
              {
                kind: "addAtom",
                space: sym("&self"),
                atom: expr([sym("="), expr([sym("native-answer")]), gint(42)]),
              },
            ],
          };
        },
      },
    );

    expect(rs[1]!.results.map(format)).toEqual(["()"]);
    expect(rs[2]!.results.map(format)).toEqual(["42"]);
    expect(rs[3]!.results.map(format)).toEqual(["(native-answer)"]);
  });

  it("does not advance world generation when pure par merges no changes", async () => {
    const generations: number[] = [];
    const observe: AsyncGroundFn = async (_args, context) => {
      generations.push(context?.generation ?? -1);
      return { tag: "ok", results: [emptyExpr] };
    };

    await runProgramAsync(
      "!(observe-generation)\n!(par 1 2)\n!(observe-generation)",
      new Map([["observe-generation", observe]]),
    );

    expect(generations).toEqual([0, 0]);
  });

  it("uses catalog imports before host resolution in and outside transactions", async () => {
    const hostImport = vi.fn(async () => ({ tag: "ok", results: [sym("host")] }) as const);
    const catalog = parseAll("(= (catalog-answer) catalog)", standardTokenizer()).map(
      (top) => top.atom,
    );
    const rs = await runProgramAsync(
      `
        !(import! &self shared-name)
        !(transaction (import! &self shared-name))
        !(catalog-answer)
      `,
      new Map(),
      100_000,
      new Map([["shared-name", catalog]]),
      { hostImport },
    );

    expect(hostImport).not.toHaveBeenCalled();
    expect(rs[2]!.results.map(format)).toEqual(["catalog", "catalog"]);
  });

  it("records the exact world delta of an opaque host import", async () => {
    let observed: GroundedCallContext | undefined;
    const inspect: AsyncGroundFn = async (_args, context) => {
      observed = context;
      return { tag: "ok", results: [emptyExpr] };
    };
    await runProgramAsync(
      `
        !(bind! &a (new-space))
        !(bind! &b (new-space))
        !(add-atom &a old)
        !(import! &a "native.mod")
        !(inspect-installation)
      `,
      new Map([["inspect-installation", inspect]]),
      100_000,
      new Map(),
      {
        hostImport: async () => ({
          tag: "ok",
          results: [emptyExpr],
          effects: [
            { kind: "removeAtom", space: sym("&space-0"), atom: sym("old") },
            { kind: "addAtom", space: sym("&space-1"), atom: sym("new") },
            { kind: "bindToken", name: "host-token", atom: sym("bound") },
          ],
        }),
      },
    );

    const installation = observed!.moduleInstallations![0]!;
    expect(installation.source).toBe("host");
    expect(installation.resolvedIdentity).toBeUndefined();
    expect(format(installation.request)).toBe('"native.mod"');
    expect(
      installation.worldDelta.addedAtoms.map((delta) => [format(delta.space), format(delta.atom)]),
    ).toEqual([["&space-1", "new"]]);
    expect(
      installation.worldDelta.removedAtoms.map((delta) => [
        format(delta.space),
        format(delta.atom),
      ]),
    ).toEqual([["&space-0", "old"]]);
    expect(
      installation.worldDelta.boundTokens.map((delta) => [delta.name, format(delta.atom)]),
    ).toEqual([["host-token", "bound"]]);
  });

  it("rejects opaque host imports before entering a transaction", async () => {
    const hostImport = vi.fn(async () => ({ tag: "ok", results: [emptyExpr] }) as const);
    const rs = await runProgramAsync(
      '!(transaction (import! &self "native.mod"))',
      new Map(),
      100_000,
      new Map(),
      { hostImport },
    );

    expect(hostImport).not.toHaveBeenCalled();
    expect(rs[0]!.results.map(format)).toEqual([
      '(Error (import! &self "native.mod") import!: host imports are not transactional)',
    ]);
  });

  it("restores mutable environment caches when an async grounded rejects", async () => {
    const env = buildEnv([...preludeAtoms(), ...stdlibAtoms()], stdTable());
    registerAsyncGroundedOperation(env, "reject", async () => {
      throw new Error("rejected");
    });
    const originalEvaluatedAtoms = env.evaluatedAtoms;
    const query = parseAll(
      "!(transaction (let $u (add-atom &self (: temporary (-> Atom Atom))) (reject)))",
      standardTokenizer(),
    )[0]!.atom;

    await expect(mettaEvalAsync(env, 100_000, initSt(), [], query)).rejects.toThrow("rejected");
    expect(env.evaluatedAtoms).toBe(originalEvaluatedAtoms);
  });

  it("pins the static program while an async query is suspended", async () => {
    const env = buildEnv(
      [...preludeAtoms(), ...stdlibAtoms(), parsedAtom("(= (late-value) old)")],
      stdTable(),
    );
    const gate = deferred();
    registerAsyncGroundedOperation(env, "pause-program", async () => {
      await gate.promise;
      return { tag: "ok", results: [emptyExpr] };
    });

    const pending = mettaEvalAsync(
      env,
      100_000,
      initSt(),
      [],
      parsedAtom("(let $ignored (pause-program) (late-value))"),
    );
    addAtomToEnv(env, parsedAtom("(= (late-value) new)"));
    gate.resolve();

    const [during] = await pending;
    const [after] = mettaEval(env, 100_000, initSt(), [], parsedAtom("(late-value)"));
    expect(during.map((pair) => format(pair[0]))).toEqual(["old"]);
    expect(after.map((pair) => format(pair[0]))).toEqual(["old", "new"]);
  });

  it("refreshes and closes an explicit async evaluation session", async () => {
    const env = buildEnv(
      [...preludeAtoms(), ...stdlibAtoms(), parsedAtom("(= (session-value) old)")],
      stdTable(),
    );
    const session = createAsyncEvaluationSession(env);
    const query = parsedAtom("(session-value)");

    const [before] = await session.evaluate(100_000, initSt(), [], query);
    addAtomToEnv(env, parsedAtom("(= (session-value) new)"));
    expect(session.isCurrent()).toBe(false);
    const [after] = await session.evaluate(100_000, initSt(), [], query);
    session.close();

    expect(before.map((pair) => format(pair[0]))).toEqual(["old"]);
    expect(after.map((pair) => format(pair[0]))).toEqual(["old", "new"]);
    expect(session.isCurrent()).toBe(false);
    await expect(session.evaluate(100_000, initSt(), [], query)).rejects.toThrow(
      "async evaluation session is closed",
    );
  });

  it("pins grounded dispatch while an async query is suspended", async () => {
    const env = buildEnv([...preludeAtoms(), ...stdlibAtoms()], stdTable());
    registerGroundedOperation(env, "snapshot-op", () => ({
      tag: "ok",
      results: [sym("old")],
    }));
    const gate = deferred();
    registerAsyncGroundedOperation(env, "pause-registry", async () => {
      await gate.promise;
      return { tag: "ok", results: [emptyExpr] };
    });

    const pending = mettaEvalAsync(
      env,
      100_000,
      initSt(),
      [],
      parsedAtom("(let $ignored (pause-registry) (snapshot-op))"),
    );
    registerGroundedOperation(env, "snapshot-op", () => ({
      tag: "ok",
      results: [sym("new")],
    }));
    gate.resolve();

    const [during] = await pending;
    const [after] = mettaEval(env, 100_000, initSt(), [], parsedAtom("(snapshot-op)"));
    expect(during.map((pair) => format(pair[0]))).toEqual(["old"]);
    expect(after.map((pair) => format(pair[0]))).toEqual(["new"]);
  });

  it("pins context service descriptors before an async grounding resumes", async () => {
    const env = buildEnv([...preludeAtoms(), ...stdlibAtoms()], stdTable());
    env.imports.set("module", [sym("old")]);
    const entered = deferred();
    const gate = deferred();
    let observed: readonly [string, boolean, boolean] | undefined;
    registerAsyncGroundedOperation(env, "inspect-after-wait", async (_args, context) => {
      entered.resolve();
      await gate.promise;
      observed = [
        format(context!.imports!.get("module")![0]!),
        context!.capabilities!.has("atomspace-read"),
        context!.groundingEnvironment!.synchronous.has("late-ground"),
      ];
      return { tag: "ok", results: [emptyExpr] };
    });

    const pending = mettaEvalAsync(env, 100_000, initSt(), [], parsedAtom("(inspect-after-wait)"));
    await entered.promise;
    env.imports.set("module", [sym("new")]);
    (env.capabilities as Set<string>).delete("atomspace-read");
    registerGroundedOperation(env, "late-ground", () => ({
      tag: "ok",
      results: [emptyExpr],
    }));
    gate.resolve();
    await pending;

    expect(observed).toEqual(["old", true, false]);
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
