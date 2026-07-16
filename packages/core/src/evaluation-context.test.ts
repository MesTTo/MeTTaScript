// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { emptyExpr, expr, gnd, sym, type Atom } from "./atom";
import { type GroundedCallContext, type GroundFn, stdTable } from "./builtins";
import {
  addAtomToEnv,
  buildEnv,
  initSt,
  mettaEval,
  type MinEnv,
  registerGroundedOperation,
  type St,
} from "./eval";
import { format, parseAll } from "./parser";
import { preludeAtoms, standardTokenizer } from "./runner";
import { stdlibAtoms } from "./stdlib";

const parsedAtom = (source: string): Atom => parseAll(`!${source}`, standardTokenizer())[0]!.atom;
const allocateSpace = (env: MinEnv): St =>
  mettaEval(env, 100_000, initSt(), [], parsedAtom("(new-space)"))[1];

const buildContextRuntime = () => {
  const env = buildEnv([...preludeAtoms(), ...stdlibAtoms()], stdTable());
  env.sharedContextAtoms = env.atoms.slice();
  const whereAmI: GroundFn = (_args, context) => {
    if (context === undefined) throw new Error("missing grounded call context");
    return { tag: "ok", results: [context.currentSpace] };
  };
  registerGroundedOperation(env, "where-am-i", whereAmI);
  return env;
};

describe("evaluation context", () => {
  it("passes the selected space to synchronous grounded operations", () => {
    const env = buildContextRuntime();

    const allocated = allocateSpace(env);
    const [pairs] = mettaEval(
      env,
      100_000,
      allocated,
      [],
      parsedAtom("(metta (where-am-i) %Undefined% &space-0)"),
    );

    expect(pairs.map((pair) => format(pair[0]))).toEqual(["&space-0"]);
  });

  it("keeps evalc context through a named rule result", () => {
    const env = buildContextRuntime();

    const allocated = allocateSpace(env);
    const [, installed] = mettaEval(
      env,
      100_000,
      allocated,
      [],
      parsedAtom(
        "(add-atom &space-0 (= (inside) (function (chain (eval (where-am-i)) $space (return $space)))))",
      ),
    );
    const [pairs] = mettaEval(env, 100_000, installed, [], parsedAtom("(evalc (inside) &space-0)"));

    expect(pairs.map((pair) => format(pair[0]))).toEqual(["&space-0"]);
  });

  it("keeps shared evaluator dependencies out of named-space membership", () => {
    const env = buildContextRuntime();
    const allocated = allocateSpace(env);
    const [, installed] = mettaEval(
      env,
      100_000,
      allocated,
      [],
      parsedAtom("(add-atom &space-0 (local fact))"),
    );
    const [pairs] = mettaEval(
      env,
      100_000,
      installed,
      [],
      parsedAtom("(evalc (get-atoms &self) &space-0)"),
    );

    expect(pairs.map((pair) => format(pair[0]))).toEqual(["(local fact)"]);
  });

  it("passes the selected space to executable grounded heads", () => {
    const env = buildEnv([...preludeAtoms(), ...stdlibAtoms()], stdTable());
    env.sharedContextAtoms = env.atoms.slice();
    const head = gnd(
      { g: "ext", kind: "operation", id: "context" },
      sym("Grounded"),
      (_args, context) => {
        if (context === undefined) throw new Error("missing grounded call context");
        return [context.currentSpace];
      },
    );
    const [, allocated] = mettaEval(env, 100_000, initSt(), [], parsedAtom("(new-space)"));
    const [pairs] = mettaEval(
      env,
      100_000,
      allocated,
      [],
      expr([sym("metta"), expr([head]), sym("%Undefined%"), sym("&space-0")]),
    );

    expect(pairs.map((pair) => format(pair[0]))).toEqual(["&space-0"]);
  });

  it("passes metta's expected type to groundeds in the root context", () => {
    const env = buildEnv([...preludeAtoms(), ...stdlibAtoms()], stdTable());
    let seen: string | undefined;
    registerGroundedOperation(env, "expected-type", (_args, context) => {
      seen = context === undefined ? undefined : format(context.expectedType);
      return { tag: "ok", results: [sym("answer")] };
    });

    const [pairs] = mettaEval(
      env,
      100_000,
      initSt(),
      [],
      parsedAtom("(metta (expected-type) Symbol &self)"),
    );

    expect(pairs.map((pair) => format(pair[0]))).toEqual(["answer"]);
    expect(seen).toBe("Symbol");
  });

  it("exposes one versioned program and world view to groundeds", () => {
    const env = buildEnv([...preludeAtoms(), ...stdlibAtoms()], stdTable());
    env.imports.set("known-module", []);
    let observed: GroundedCallContext | undefined;
    registerGroundedOperation(env, "inspect-context", (_args, context) => {
      observed = context;
      return { tag: "ok", results: [emptyExpr] };
    });

    const [, changed] = mettaEval(
      env,
      100_000,
      initSt(),
      [],
      parsedAtom("(add-atom &self (: dynamic-value RuntimeType))"),
    );
    const [, imported] = mettaEval(
      env,
      100_000,
      changed,
      [],
      parsedAtom("(import! &self known-module)"),
    );
    mettaEval(env, 100_000, imported, [], parsedAtom("(inspect-context)"));

    expect(observed).toBeDefined();
    expect(observed!.generation).toBeGreaterThan(0);
    expect(observed!.groundingEnvironment!.synchronous.has("inspect-context")).toBe(true);
    expect(observed!.imports!.has("known-module")).toBe(true);
    expect(observed!.capabilities!.has("atomspace-read")).toBe(true);
    expect(observed!.moduleInstallations).toHaveLength(1);
    expect(observed!.moduleInstallations![0]!.resolvedIdentity).toBe("known-module");
    expect(format(observed!.moduleInstallations![0]!.targetSpace)).toBe("&self");
    expect(observed!.moduleInstallations![0]!.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(observed!.typeEnvironment!.declaredTypes.get("dynamic-value")!.map(format)).toEqual([
      "RuntimeType",
    ]);
  });

  it("does not expose mutable interpreter collections to groundeds", () => {
    const env = buildEnv([...preludeAtoms(), ...stdlibAtoms()], stdTable());
    env.imports.set("known-module", [sym("payload")]);
    registerGroundedOperation(env, "try-context-mutation", (_args, context) => {
      if (context === undefined) throw new Error("missing grounded call context");
      expect(() =>
        (context.typeEnvironment!.signatures as Map<string, readonly Atom[]>).set("poison", []),
      ).toThrow(TypeError);
      expect(() => (context.imports as Map<string, readonly Atom[]>).clear()).toThrow(TypeError);
      expect(() => (context.capabilities as Set<string>).delete("atomspace-read")).toThrow(
        TypeError,
      );
      return { tag: "ok", results: [emptyExpr] };
    });

    mettaEval(env, 100_000, initSt(), [], parsedAtom("(try-context-mutation)"));

    expect(env.sigs.has("poison")).toBe(false);
    expect(env.imports.has("known-module")).toBe(true);
    expect(env.capabilities!.has("atomspace-read")).toBe(true);
  });

  it("invalidates cached service descriptors after in-place registry changes", () => {
    const env = buildEnv([...preludeAtoms(), ...stdlibAtoms()], stdTable());
    env.imports.set("module", [sym("old")]);
    const observed: Array<readonly [string, boolean, boolean]> = [];
    registerGroundedOperation(env, "inspect-services", (_args, context) => {
      observed.push([
        format(context!.imports!.get("module")![0]!),
        context!.capabilities!.has("atomspace-read"),
        context!.groundingEnvironment!.synchronous.has("late-ground"),
      ]);
      return { tag: "ok", results: [emptyExpr] };
    });
    const state = initSt();

    mettaEval(env, 100_000, state, [], parsedAtom("(inspect-services)"));
    env.imports.set("module", [sym("new")]);
    (env.capabilities as Set<string>).delete("atomspace-read");
    env.gt.set("late-ground", () => ({ tag: "ok", results: [emptyExpr] }));
    mettaEval(env, 100_000, state, [], parsedAtom("(inspect-services)"));

    expect(observed).toEqual([
      ["old", true, false],
      ["new", false, true],
    ]);
  });

  it("uses lineage-local deterministic generations", () => {
    const generationAfterOneMutation = (): number => {
      const env = buildEnv([...preludeAtoms(), ...stdlibAtoms()], stdTable());
      let observed = -1;
      registerGroundedOperation(env, "observe-generation", (_args, context) => {
        observed = context?.generation ?? -1;
        return { tag: "ok", results: [emptyExpr] };
      });
      const [, changed] = mettaEval(
        env,
        100_000,
        initSt(),
        [],
        parsedAtom("(add-atom &self value)"),
      );
      mettaEval(env, 100_000, changed, [], parsedAtom("(observe-generation)"));
      return observed;
    };

    expect(generationAfterOneMutation()).toBe(1);
    expect(generationAfterOneMutation()).toBe(1);
  });

  it("invalidates a dynamic type view when the static type program grows", () => {
    const env = buildEnv([...preludeAtoms(), ...stdlibAtoms()], stdTable());
    const [, changed] = mettaEval(
      env,
      100_000,
      initSt(),
      [],
      parsedAtom("(add-atom &self (: dynamic Dynamic))"),
    );
    mettaEval(env, 100_000, changed, [], parsedAtom("(get-type dynamic)"));
    addAtomToEnv(env, parsedAtom("(: later Later)"));

    const [pairs] = mettaEval(env, 100_000, changed, [], parsedAtom("(get-type later)"));

    expect(pairs.map((pair) => format(pair[0]))).toEqual(["Later"]);
  });

  it("does not reuse a type view across distinct program owners", () => {
    const envA = buildEnv(
      [...preludeAtoms(), ...stdlibAtoms(), parsedAtom("(: owned TypeA)")],
      stdTable(),
    );
    const envB = buildEnv(
      [...preludeAtoms(), ...stdlibAtoms(), parsedAtom("(: owned TypeB)")],
      stdTable(),
    );
    const [, changed] = mettaEval(
      envA,
      100_000,
      initSt(),
      [],
      parsedAtom("(add-atom &self (: dynamic Dynamic))"),
    );
    mettaEval(envA, 100_000, changed, [], parsedAtom("(get-type owned)"));

    const [pairs] = mettaEval(envB, 100_000, changed, [], parsedAtom("(get-type owned)"));

    expect(pairs.map((pair) => format(pair[0]))).toEqual(["TypeB"]);
  });

  it("invalidates normal-form caches after removing a runtime type", () => {
    const env = buildEnv(
      [...preludeAtoms(), ...stdlibAtoms(), parsedAtom("(= (bar) B)")],
      stdTable(),
    );
    const type = parsedAtom("(: foo (-> Atom Atom))");
    const query = parsedAtom("(foo (bar))");
    const [, typed] = mettaEval(
      env,
      100_000,
      initSt(),
      [],
      expr([sym("add-atom"), sym("&self"), type]),
    );
    const [before] = mettaEval(env, 100_000, typed, [], query);
    const [, untyped] = mettaEval(
      env,
      100_000,
      typed,
      [],
      expr([sym("remove-atom"), sym("&self"), type]),
    );
    const [after] = mettaEval(env, 100_000, untyped, [], query);

    expect(before.map((pair) => format(pair[0]))).toEqual(["(foo (bar))"]);
    expect(after.map((pair) => format(pair[0]))).toEqual(["(foo B)"]);
  });
});
