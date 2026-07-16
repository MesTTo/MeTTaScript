// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

import { describe, it, expect } from "vitest";
import { sym, type Atom } from "./atom";
import { stdTable } from "./builtins";
import { buildEnv, initSt, mettaEval, registerGroundedOperation, type MinEnv } from "./eval";
import { runProgram, preludeAtoms } from "./runner";
import { format, parseAll } from "./parser";
import { standardTokenizer } from "./runner";
import { stdlibAtoms } from "./stdlib";
import { TableSpace } from "./table-space";

// `transaction` (TS-native extension, opt-in via `!(import! &self concurrency)`): evaluate the body
// and commit its space mutations only on success; roll back (snapshot/restore the copy-on-write world)
// on a thrown Error atom or zero results. `collapse` renders a LeaTTa comma tuple `(, a b ...)`.
const last = (src: string): string[] => {
  const rs = runProgram(src);
  return rs[rs.length - 1]!.results.map(format);
};
const parsedAtom = (source: string): Atom => parseAll(`!${source}`, standardTokenizer())[0]!.atom;
const transactionEnv = (): MinEnv => buildEnv([...preludeAtoms(), ...stdlibAtoms()], stdTable());

describe("transaction", () => {
  it("commits space mutations when the body adds and returns a value", () => {
    expect(
      last(`
        !(import! &self concurrency)
        !(add-atom &self (cnt 5))
        !(transaction (add-atom &self (cnt 7)))
        !(collapse (match &self (cnt $v) $v))
      `),
    ).toEqual(["(, 5 7)"]);
  });

  it("rolls back when the body adds then produces zero results", () => {
    expect(
      last(`
        !(import! &self concurrency)
        !(add-atom &self (cnt 5))
        !(transaction (let $u (add-atom &self (cnt 6)) (superpose ())))
        !(collapse (match &self (cnt $v) $v))
      `),
    ).toEqual(["(, 5)"]);
  });

  it("the transaction itself returns the body's results (zero on rollback)", () => {
    expect(
      last(`
        !(import! &self concurrency)
        !(transaction (let $u (add-atom &self (cnt 6)) (superpose ())))
      `),
    ).toEqual([]);
  });

  it("a superpose body with an Empty branch still commits (Empty is a value, not failure)", () => {
    // The body produces results (1 and the symbol Empty), so it commits; the add stays.
    expect(
      last(`
        !(import! &self concurrency)
        !(add-atom &self (cnt 5))
        !(transaction (let $u (add-atom &self (cnt 9)) (superpose (1 Empty))))
        !(collapse (match &self (cnt $v) $v))
      `),
    ).toEqual(["(, 5 9)"]);
  });

  it("rolls back type declarations installed by an import", () => {
    const imported = parseAll(
      `
        (: imported-value ImportedType)
        (= (from-import) imported-value)
      `,
      standardTokenizer(),
    ).map((top) => top.atom);
    const rs = runProgram(
      `
        !(import! &self concurrency)
        !(transaction (let $u (import! &self typed-module) (superpose ())))
        !(get-type imported-value)
        !(from-import)
      `,
      2_000_000,
      new Map([["typed-module", imported]]),
    );

    expect(rs[2]!.results.map(format)).toEqual(["%Undefined%"]);
    expect(rs[3]!.results.map(format)).toEqual(["(from-import)"]);
  });

  it("commits type declarations installed by a successful import", () => {
    const imported = parseAll(
      `
        (: committed-value CommittedType)
        (= (committed-rule) committed-value)
      `,
      standardTokenizer(),
    ).map((top) => top.atom);
    const rs = runProgram(
      `
        !(import! &self concurrency)
        !(transaction (import! &self committed-module))
        !(get-type committed-value)
        !(committed-rule)
      `,
      2_000_000,
      new Map([["committed-module", imported]]),
    );

    expect(rs[2]!.results.map(format)).toEqual(["CommittedType"]);
    expect(rs[3]!.results.map(format)).toEqual(["committed-value"]);
  });

  it("rolls back and commits module-installation history with the world", () => {
    const env = transactionEnv();
    env.imports.set("module", [sym("payload")]);
    const [, rolledBack] = mettaEval(
      env,
      100_000,
      initSt(),
      [],
      parsedAtom("(transaction (let $u (import! &self module) (superpose ())))"),
    );
    expect(rolledBack.world.moduleInstallations).toEqual([]);

    const [, committed] = mettaEval(
      env,
      100_000,
      rolledBack,
      [],
      parsedAtom("(transaction (import! &self module))"),
    );
    expect(committed.world.moduleInstallations).toHaveLength(1);
    expect(committed.world.moduleInstallations[0]!.resolvedIdentity).toBe("module");
    expect(
      committed.world.moduleInstallations[0]!.worldDelta.addedAtoms.map((delta) => [
        format(delta.space),
        format(delta.atom),
      ]),
    ).toEqual([["&self", "payload"]]);
  });

  it("records repeated and empty catalog imports as distinct installations", () => {
    const env = transactionEnv();
    env.imports.set("module", [sym("payload")]);
    env.imports.set("empty-module", []);
    const [, first] = mettaEval(env, 100_000, initSt(), [], parsedAtom("(import! &self module)"));
    const [, second] = mettaEval(env, 100_000, first, [], parsedAtom("(import! &self module)"));
    const [, third] = mettaEval(
      env,
      100_000,
      second,
      [],
      parsedAtom("(import! &self empty-module)"),
    );

    expect(third.world.moduleInstallations.map((record) => record.resolvedIdentity)).toEqual([
      "module",
      "module",
      "empty-module",
    ]);
    expect(third.world.moduleInstallations[2]!.worldDelta.addedAtoms).toEqual([]);
    expect(third.world.generation).toBe(3);
    const [atoms] = mettaEval(env, 100_000, third, [], parsedAtom("(match &self payload payload)"));
    expect(atoms.map((pair) => format(pair[0]))).toEqual(["payload", "payload"]);
  });

  it("restores semantic cache ownership and clears tables after a failed type mutation", () => {
    const env = transactionEnv();
    const table = new TableSpace();
    env.tableSpace = table;
    const key = table.key("ground", parsedAtom("(cached)"), 0);
    table.rememberCompleted(key, 0, [sym("cached-answer")]);
    const originalEvaluatedAtoms = env.evaluatedAtoms;

    mettaEval(
      env,
      100_000,
      initSt(),
      [],
      parsedAtom(
        "(transaction (let $u (add-atom &self (: temporary (-> Atom Atom))) (superpose ())))",
      ),
    );

    expect(env.evaluatedAtoms).toBe(originalEvaluatedAtoms);
    expect(table.stats().entries).toBe(0);
  });

  it("restores mutable environment caches when a grounded throws", () => {
    const env = transactionEnv();
    registerGroundedOperation(env, "explode", () => {
      throw new Error("boom");
    });
    const originalEvaluatedAtoms = env.evaluatedAtoms;
    const query = parsedAtom(
      "(transaction (let $u (add-atom &self (: temporary (-> Atom Atom))) (explode)))",
    );

    expect(() => mettaEval(env, 100_000, initSt(), [], query)).toThrow("boom");
    expect(env.evaluatedAtoms).toBe(originalEvaluatedAtoms);
  });
});
