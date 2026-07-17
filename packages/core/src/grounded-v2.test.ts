// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { expr, format, gint, gnd, gstr, matchAtoms, sym } from "./index";
import {
  buildEnv,
  createMinimalAsyncSearchCursor,
  createMinimalSearchCursor,
  createMettaAsyncSearchCursor,
  createMettaSearchCursor,
  groundedExecutableV2,
  groundedHostImportV2,
  groundedMatcherV2,
  initSt,
  mettaEval,
  registerGroundedOperationV2,
  branchRuntimeSnapshot,
} from "./eval";
import {
  groundedAsyncAnswers,
  groundedSyncAnswers,
  type GroundedCallContextV2,
} from "./grounded-v2";
import { parseAll } from "./parser";
import { composeHostInterops } from "./host";
import { preludeAtoms } from "./runner";
import { standardTokenizer } from "./standard-syntax";
import { stdlibAtoms } from "./stdlib";
import { stdTable } from "./builtins";
import { emptyBindingFrame } from "./binding-frame";
import { makeValRel } from "./bindings";
import { RuntimeIdAllocator } from "./trace";
import { VariableScope } from "./variable-scope";

const pureSync = {
  mode: "sync" as const,
  effects: { classes: ["pure" as const], speculative: true },
};

const pureAsync = {
  mode: "async" as const,
  effects: { classes: ["pure" as const], speculative: true },
};

function runtime() {
  return buildEnv([...preludeAtoms(), ...stdlibAtoms()], stdTable());
}

function atom(source: string) {
  return parseAll(source, standardTokenizer())[0]!.atom;
}

describe("Grounded V2 answer cursors", () => {
  it("pulls one synchronous answer at a time and closes the unvisited tail", () => {
    let produced = 0;
    let closed = 0;
    function* source() {
      try {
        for (;;) {
          produced += 1;
          yield { atom: gint(produced) };
        }
      } finally {
        closed += 1;
      }
    }

    const cursor = groundedSyncAnswers(source());
    expect(cursor.next()).toMatchObject({ kind: "answer", value: { atom: gint(1) } });
    expect(produced).toBe(1);
    cursor.close({ code: "test-prune" });
    expect(produced).toBe(1);
    expect(closed).toBe(1);
  });

  it("drives yielded synchronous cleanup to completion", () => {
    let closed = false;
    function* source() {
      try {
        yield { atom: sym("answer") };
      } finally {
        yield { atom: sym("cleanup-step") };
        closed = true;
      }
    }

    const cursor = groundedSyncAnswers(source());
    expect(cursor.next().kind).toBe("answer");
    cursor.close({ code: "test-prune" });
    expect(closed).toBe(true);
  });

  it("joins an asynchronous source finalizer on close", async () => {
    let closed = false;
    async function* source() {
      try {
        yield { atom: sym("first") };
        await new Promise<never>(() => undefined);
      } finally {
        closed = true;
      }
    }

    const cursor = groundedAsyncAnswers(source());
    await expect(cursor.next()).resolves.toMatchObject({
      kind: "answer",
      value: { atom: sym("first") },
    });
    await cursor.close({ code: "test-prune" });
    expect(closed).toBe(true);
  });

  it("drives yielded asynchronous cleanup to completion", async () => {
    let closed = false;
    async function* source() {
      try {
        yield { atom: sym("answer") };
      } finally {
        yield { atom: sym("cleanup-step") };
        await Promise.resolve();
        closed = true;
      }
    }

    const cursor = groundedAsyncAnswers(source());
    expect((await cursor.next()).kind).toBe("answer");
    await cursor.close({ code: "test-prune" });
    expect(closed).toBe(true);
  });

  it("never pulls beyond a requested finite prefix", () => {
    fc.assert(
      fc.property(fc.array(fc.integer(), { maxLength: 64 }), fc.nat(64), (values, requested) => {
        let produced = 0;
        const cursor = groundedSyncAnswers(
          (function* () {
            for (const value of values) {
              produced += 1;
              yield { atom: gint(value) };
            }
          })(),
        );
        const expected = Math.min(values.length, requested);
        for (let index = 0; index < expected; index += 1) expect(cursor.next().kind).toBe("answer");
        if (requested > values.length) expect(cursor.next().kind).toBe("exhausted");
        cursor.close({ code: "property-prefix" });
        expect(produced).toBe(expected);
      }),
    );
  });
});

describe("Grounded V2 evaluator boundary", () => {
  it("keeps a raw Minimal eval pull-based and closes its retained continuation", () => {
    const env = runtime();
    let produced = 0;
    let closed = 0;
    registerGroundedOperationV2(
      env,
      "minimal-naturals-v2",
      () => ({
        tag: "answers",
        answers: groundedSyncAnswers(
          (function* () {
            try {
              for (let value = 0; ; value += 1) {
                produced += 1;
                yield { atom: gint(value) };
              }
            } finally {
              closed += 1;
            }
          })(),
        ),
      }),
      pureSync,
    );

    const cursor = createMinimalSearchCursor(env, atom("(eval (minimal-naturals-v2))"));
    expect(cursor.next({ maxSteps: 100 })).toMatchObject({
      kind: "answer",
      value: { atom: gint(0) },
    });
    expect(produced).toBe(1);
    cursor.close({ code: "test-prune" });
    expect(produced).toBe(1);
    expect(closed).toBe(1);
  });

  it("joins an async Minimal grounded continuation when its consumer closes", async () => {
    const env = runtime();
    let closed = false;
    registerGroundedOperationV2(
      env,
      "minimal-async-v2",
      () => ({
        tag: "answers",
        answers: groundedAsyncAnswers(
          (async function* () {
            try {
              yield { atom: sym("first") };
              await new Promise<never>(() => undefined);
            } finally {
              closed = true;
            }
          })(),
        ),
      }),
      pureAsync,
    );

    const cursor = createMinimalAsyncSearchCursor(env, atom("(eval (minimal-async-v2))"));
    await expect(cursor.next({ maxSteps: 100 })).resolves.toMatchObject({
      kind: "answer",
      value: { atom: sym("first") },
    });
    await cursor.close({ code: "test-prune" });
    expect(closed).toBe(true);
  });

  it("lets once observe one answer without enumerating an infinite grounded tail", () => {
    const env = runtime();
    let produced = 0;
    let closed = 0;
    registerGroundedOperationV2(
      env,
      "naturals-v2",
      () => ({
        tag: "answers",
        answers: groundedSyncAnswers(
          (function* () {
            try {
              for (let value = 0; ; value += 1) {
                produced += 1;
                yield { atom: gint(value) };
              }
            } finally {
              closed += 1;
            }
          })(),
        ),
      }),
      pureSync,
    );

    const [pairs] = mettaEval(env, 100_000, initSt(), [], atom("(once (naturals-v2))"));
    expect(pairs.map(([result]) => format(result))).toEqual(["0"]);
    expect(produced).toBe(1);
    expect(closed).toBe(1);
  });

  it("changes once over N host answers from N production work to one pull", () => {
    const count = 4_096;
    const legacyEnv = runtime();
    let legacyProduced = 0;
    legacyEnv.gt.set("legacy-many", () => ({
      tag: "ok",
      results: Array.from({ length: count }, (_, value) => {
        legacyProduced += 1;
        return gint(value);
      }),
    }));
    const [legacy] = mettaEval(legacyEnv, 100_000, initSt(), [], atom("(once (legacy-many))"));

    const streamedEnv = runtime();
    let streamedProduced = 0;
    registerGroundedOperationV2(
      streamedEnv,
      "streamed-many",
      () => ({
        tag: "answers",
        answers: groundedSyncAnswers(
          (function* () {
            for (let value = 0; value < count; value += 1) {
              streamedProduced += 1;
              yield { atom: gint(value) };
            }
          })(),
        ),
      }),
      pureSync,
    );
    const [streamed] = mettaEval(
      streamedEnv,
      100_000,
      initSt(),
      [],
      atom("(once (streamed-many))"),
    );

    expect(legacy.map(([result]) => format(result))).toEqual(["0"]);
    expect(streamed.map(([result]) => format(result))).toEqual(["0"]);
    expect(legacyProduced).toBe(count);
    expect(streamedProduced).toBe(1);
  });

  it("matches finite legacy result arrays for arbitrary answer sequences", () => {
    fc.assert(
      fc.property(fc.array(fc.integer(), { maxLength: 32 }), (values) => {
        const legacyEnv = runtime();
        legacyEnv.gt.set("finite-legacy", () => ({
          tag: "ok",
          results: values.map(gint),
        }));
        const [legacy] = mettaEval(legacyEnv, 100_000, initSt(), [], atom("(finite-legacy)"));

        const streamedEnv = runtime();
        registerGroundedOperationV2(
          streamedEnv,
          "finite-v2",
          () => ({
            tag: "answers",
            answers: groundedSyncAnswers(
              (function* () {
                for (const value of values) yield { atom: gint(value) };
              })(),
            ),
          }),
          pureSync,
        );
        const [streamed] = mettaEval(streamedEnv, 100_000, initSt(), [], atom("(finite-v2)"));

        expect(streamed.map(([result]) => format(result))).toEqual(
          legacy.map(([result]) => format(result)),
        );
      }),
    );
  });

  it("streams executable grounded heads through the same owned boundary", () => {
    const env = runtime();
    let produced = 0;
    let closed = 0;
    const head = gnd(
      { g: "ext", kind: "grounded-v2-test", id: "streaming-head" },
      sym("Grounded"),
      groundedExecutableV2(
        () => ({
          tag: "answers",
          answers: groundedSyncAnswers(
            (function* () {
              try {
                for (let value = 0; ; value += 1) {
                  produced += 1;
                  yield { atom: gint(value) };
                }
              } finally {
                closed += 1;
              }
            })(),
          ),
        }),
        pureSync,
      ),
    );

    const cursor = createMettaSearchCursor(env, expr([head]));
    expect(cursor.next({ maxSteps: 100 })).toMatchObject({
      kind: "answer",
      value: { atom: gint(0) },
    });
    expect(produced).toBe(1);
    cursor.close({ code: "test-prune" });
    expect(produced).toBe(1);
    expect(closed).toBe(1);
  });

  it("uses the same typed context and answer protocol for host imports", () => {
    const env = runtime();
    let observed: GroundedCallContextV2 | undefined;
    env.hostImport = groundedHostImportV2((args, context) => {
      observed = context;
      return {
        tag: "answers",
        answers: groundedSyncAnswers([{ atom: expr([sym("loaded"), ...args]) }]),
      };
    }, pureSync);

    const [pairs, state] = mettaEval(
      env,
      100_000,
      initSt({ resources: { track: true } }),
      [],
      atom('(import! &self "module-v2")'),
    );
    expect(pairs.map(([result]) => format(result))).toEqual(['(loaded &self "module-v2")']);
    expect(observed?.originalArgs.map(format)).toEqual(["&self", '"module-v2"']);
    expect(observed?.resources.ledger.tracked).toBe(true);
    expect(observed?.trace.traceId).toMatch(/^trace:/);
    expect(state.world.moduleInstallations).toHaveLength(1);
  });

  it("preserves the V2 boundary when host import fallbacks are composed", async () => {
    const env = runtime();
    let calls = 0;
    const skipped = groundedHostImportV2(() => ({ tag: "stuck" }), pureSync);
    const selected = groundedHostImportV2(async () => {
      calls += 1;
      return {
        tag: "answers",
        answers: groundedAsyncAnswers(
          (async function* () {
            yield { atom: sym("composed") };
          })(),
        ),
      };
    }, pureAsync);
    env.hostImport = composeHostInterops([
      { name: "skip", hostImport: skipped },
      { name: "select", hostImport: selected },
    ]).hostImport!;

    const results = await mettaEvalAsyncResult(env, atom('(import! &self "composed-v2")'));
    expect(results.map(([result]) => format(result))).toEqual(["composed"]);
    expect(calls).toBe(1);
  });

  it("does not hoist a later host fallback capability onto an earlier answer", () => {
    const env = runtime();
    let guardedCalls = 0;
    const selected = groundedHostImportV2(
      () => ({
        tag: "answers",
        answers: groundedSyncAnswers([{ atom: sym("selected-without-guard") }]),
      }),
      pureSync,
    );
    const guarded = groundedHostImportV2(
      () => {
        guardedCalls += 1;
        return {
          tag: "answers",
          answers: groundedSyncAnswers([{ atom: sym("guarded-fallback") }]),
        };
      },
      { ...pureSync, requiredCapabilities: ["later-fallback-capability"] },
    );
    env.hostImport = composeHostInterops([
      { name: "selected", hostImport: selected },
      { name: "guarded", hostImport: guarded },
    ]).hostImport!;

    const [pairs] = mettaEval(env, 100_000, initSt(), [], atom('(import! &self "fallback")'));
    expect(pairs.map(([result]) => format(result))).toEqual(["selected-without-guard"]);
    expect(guardedCalls).toBe(0);
  });

  it("returns custom-matcher bindings through the same checked frame delta", () => {
    const matcher = groundedMatcherV2((_args, context) => {
      const output = context.scope.variable("x");
      const bound = context.bindings.bind(output, sym("matched"));
      if (!bound.ok)
        return {
          tag: "host-fault",
          fault: {
            kind: "infrastructure-fault",
            phase: "matcher-bind",
            message: bound.fault.message,
          },
        };
      return {
        tag: "answers",
        answers: groundedSyncAnswers([{ atom: sym("match"), bindingDelta: bound.value }]),
      };
    }, pureSync);
    const left = gnd(
      { g: "ext", kind: "grounded-v2-test", id: "matcher" },
      sym("Grounded"),
      undefined,
      matcher,
    );

    const results = matchAtoms(left, sym("input"));
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual([
      expect.objectContaining({
        tag: "val",
        x: expect.stringMatching(/^x#\d+$/),
        a: sym("matched"),
      }),
    ]);
  });

  it("merges aliases and values returned in an answer binding delta", () => {
    const env = runtime();
    registerGroundedOperationV2(
      env,
      "alias-v2",
      (_args, context: GroundedCallContextV2) => {
        const [left, right] = context.visibleVariables;
        if (left === undefined || right === undefined)
          return { tag: "language-error", error: gstr("two visible variables required") };
        const aliased = context.bindings.equate(left, right);
        if (!aliased.ok) return { tag: "language-error", error: gstr(aliased.fault.message) };
        const bound = aliased.value.bind(right, sym("B"));
        if (!bound.ok) return { tag: "language-error", error: gstr(bound.fault.message) };
        return {
          tag: "answers",
          answers: groundedSyncAnswers([{ atom: expr([left, right]), bindingDelta: bound.value }]),
        };
      },
      pureSync,
    );

    const [pairs] = mettaEval(env, 100_000, initSt(), [], atom("(alias-v2 $x $y)"));
    expect(pairs.map(([result]) => format(result))).toEqual(["(B B)"]);
  });

  it("keeps distinct answer binding deltas as separate alternatives", () => {
    const env = runtime();
    registerGroundedOperationV2(
      env,
      "binding-alternatives-v2",
      (_args, context) => {
        const output = context.visibleVariables[0];
        if (output === undefined)
          return { tag: "language-error", error: gstr("one visible variable required") };
        const answers = [sym("A"), sym("B")].map((value) => {
          const bound = context.bindings.bind(output, value);
          if (!bound.ok) throw new Error(bound.fault.message);
          return { atom: output, bindingDelta: bound.value };
        });
        return { tag: "answers", answers: groundedSyncAnswers(answers) };
      },
      pureSync,
    );

    const [pairs] = mettaEval(env, 100_000, initSt(), [], atom("(binding-alternatives-v2 $x)"));
    expect(pairs.map(([result]) => format(result))).toEqual(["A", "B"]);
  });

  it("drops only the answer whose binding delta conflicts with the caller frame", () => {
    const env = runtime();
    registerGroundedOperationV2(
      env,
      "conflicting-delta-v2",
      (_args, context) => {
        const output = context.visibleVariables[0];
        if (output === undefined)
          return { tag: "language-error", error: gstr("one visible variable required") };
        const conflicting = emptyBindingFrame.bind(output, sym("B"));
        if (!conflicting.ok) throw new Error(conflicting.fault.message);
        return {
          tag: "answers",
          answers: groundedSyncAnswers([
            { atom: output, bindingDelta: conflicting.value },
            { atom: output },
          ]),
        };
      },
      pureSync,
    );

    const [pairs] = mettaEval(
      env,
      100_000,
      initSt(),
      [makeValRel("x", sym("A"))],
      atom("(conflicting-delta-v2 $x)"),
    );
    expect(pairs.map(([result]) => format(result))).toEqual(["A"]);
  });

  it("rejects variables minted outside the caller or call scope", () => {
    const env = runtime();
    const foreign = new VariableScope(new RuntimeIdAllocator("foreign-v2").next("scope"));
    registerGroundedOperationV2(
      env,
      "foreign-scope-v2",
      () => ({
        tag: "answers",
        answers: groundedSyncAnswers([{ atom: foreign.variable("escaped") }]),
      }),
      pureSync,
    );

    expect(() => mettaEval(env, 100_000, initSt(), [], atom("(foreign-scope-v2)"))).toThrowError(
      expect.objectContaining({
        kind: "infrastructure-fault",
        phase: "grounded-bindings",
      }),
    );
  });

  it("checks required capabilities before invoking host code", () => {
    const env = runtime();
    let invoked = false;
    registerGroundedOperationV2(
      env,
      "capability-v2",
      () => {
        invoked = true;
        return { tag: "answers", answers: groundedSyncAnswers([]) };
      },
      { ...pureSync, requiredCapabilities: ["missing-v2-capability"] },
    );

    expect(() => mettaEval(env, 100_000, initSt(), [], atom("(capability-v2)"))).toThrowError(
      expect.objectContaining({
        kind: "infrastructure-fault",
        phase: "grounded-capability",
      }),
    );
    expect(invoked).toBe(false);
  });

  it("pins V2 registration identity with the evaluator snapshot", () => {
    const env = runtime();
    registerGroundedOperationV2(
      env,
      "pinned-v2",
      () => ({
        tag: "answers",
        answers: groundedSyncAnswers([{ atom: sym("old") }]),
      }),
      pureSync,
    );
    const pinned = createMettaSearchCursor(env, atom("(pinned-v2)"));
    registerGroundedOperationV2(
      env,
      "pinned-v2",
      () => ({
        tag: "answers",
        answers: groundedSyncAnswers([{ atom: sym("new") }]),
      }),
      pureSync,
    );

    expect(pinned.next({ maxSteps: 100 })).toMatchObject({
      kind: "answer",
      value: { atom: sym("old") },
    });
    const [current] = mettaEval(env, 100_000, initSt(), [], atom("(pinned-v2)"));
    expect(current.map(([result]) => format(result))).toEqual(["new"]);
    pinned.close();
  });

  it("debits result and reachable atom cells as each answer is published", () => {
    const env = runtime();
    registerGroundedOperationV2(
      env,
      "accounted-v2",
      () => ({
        tag: "answers",
        answers: groundedSyncAnswers([
          { atom: expr([sym("pair"), sym("a"), sym("b")]) },
          { atom: sym("second") },
        ]),
      }),
      pureSync,
    );
    const state = initSt({ resources: { limits: { results: 1 }, track: true } });
    const cursor = createMettaSearchCursor(env, atom("(accounted-v2)"), { state });

    const first = cursor.next({ maxSteps: 100 });
    expect(first.kind).toBe("answer");
    if (first.kind !== "answer") throw new Error("expected first answer");
    expect(branchRuntimeSnapshot(first.value.state).resources.used.results).toBe(1);
    expect(branchRuntimeSnapshot(first.value.state).resources.used["atom-cells"]).toBe(4);
    const second = cursor.next({ maxSteps: 100 });
    expect(second).toMatchObject({
      kind: "fault",
      error: { kind: "resource-limit", fault: { resource: "results" } },
    });
  });

  it("applies pre-effects once even when the answer stream is empty", () => {
    const env = runtime();
    registerGroundedOperationV2(
      env,
      "empty-effect-v2",
      () => ({
        tag: "answers",
        preEffects: [{ kind: "bindToken", name: "v2-pre-effect", atom: sym("seen") }],
        answers: groundedSyncAnswers([]),
      }),
      {
        mode: "sync",
        effects: { classes: ["atomspace-write"], speculative: true },
      },
    );

    const [pairs, state] = mettaEval(env, 100_000, initSt(), [], atom("(empty-effect-v2)"));
    expect(pairs).toEqual([]);
    expect(state.world.tokens.get("v2-pre-effect")).toEqual(sym("seen"));
  });

  it("isolates per-answer effects before nondeterministic branches merge", () => {
    const env = runtime();
    registerGroundedOperationV2(
      env,
      "isolated-answers-v2",
      () => ({
        tag: "answers",
        answers: groundedSyncAnswers([
          {
            atom: sym("left"),
            effects: [{ kind: "bindToken", name: "left-token", atom: sym("left") }],
          },
          {
            atom: sym("right"),
            effects: [{ kind: "bindToken", name: "right-token", atom: sym("right") }],
          },
        ]),
      }),
      {
        mode: "sync",
        effects: { classes: ["atomspace-write"], speculative: true },
      },
    );

    const cursor = createMettaSearchCursor(env, atom("(hyperpose ((isolated-answers-v2)))"));
    const left = cursor.next({ maxSteps: 1_000 });
    expect(left).toMatchObject({ kind: "answer", value: { atom: sym("left") } });
    if (left.kind !== "answer") throw new Error("expected left answer");
    expect(left.value.state.world.tokens.get("left-token")).toEqual(sym("left"));
    expect(left.value.state.world.tokens.has("right-token")).toBe(false);

    const right = cursor.next({ maxSteps: 1_000 });
    expect(right).toMatchObject({ kind: "answer", value: { atom: sym("right") } });
    if (right.kind !== "answer") throw new Error("expected right answer");
    expect(right.value.state.world.tokens.get("right-token")).toEqual(sym("right"));
    expect(right.value.state.world.tokens.has("left-token")).toBe(false);

    const exhausted = cursor.next({ maxSteps: 1_000 });
    expect(exhausted.kind).toBe("exhausted");
    if (exhausted.kind !== "exhausted") throw new Error("expected exhausted cursor");
    expect(exhausted.terminal.world.tokens.get("left-token")).toEqual(sym("left"));
    expect(exhausted.terminal.world.tokens.get("right-token")).toEqual(sym("right"));
  });

  it("surfaces a fault raised after an earlier asynchronous answer", async () => {
    const env = runtime();
    registerGroundedOperationV2(
      env,
      "late-fault-v2",
      () => ({
        tag: "answers",
        answers: groundedAsyncAnswers(
          (async function* () {
            yield { atom: sym("first") };
            throw new Error("late grounded failure");
          })(),
        ),
      }),
      pureAsync,
    );

    await expect(mettaEvalAsyncResult(env, atom("(late-fault-v2)"))).rejects.toMatchObject({
      kind: "infrastructure-fault",
      phase: "grounded-next",
      message: "late grounded failure",
    });
  });

  it("surfaces producer cleanup failure at the grounded-close boundary", () => {
    const env = runtime();
    registerGroundedOperationV2(
      env,
      "cleanup-fault-v2",
      () => ({
        tag: "answers",
        answers: groundedSyncAnswers(
          (function* () {
            try {
              yield { atom: sym("first") };
              yield { atom: sym("unvisited") };
            } finally {
              throw new Error("grounded cleanup failed");
            }
          })(),
        ),
      }),
      pureSync,
    );

    const cursor = createMettaSearchCursor(env, atom("(cleanup-fault-v2)"));
    expect(cursor.next({ maxSteps: 100 })).toMatchObject({
      kind: "answer",
      value: { atom: sym("first") },
    });
    expect(() => cursor.close({ code: "test-prune" })).toThrowError(
      expect.objectContaining({
        kind: "infrastructure-fault",
        phase: "grounded-close",
        message: "grounded cleanup failed",
      }),
    );
  });

  it("cancels an in-flight pull and joins its producer before close resolves", async () => {
    const env = runtime();
    let entered!: () => void;
    const pulling = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let closed = false;
    registerGroundedOperationV2(
      env,
      "cancel-pull-v2",
      (_args, context) => ({
        tag: "answers",
        answers: groundedAsyncAnswers(
          (async function* () {
            try {
              yield { atom: sym("first") };
              entered();
              await new Promise<void>((_resolve, reject) => {
                const stop = (): void => reject(context.signal.reason);
                if (context.signal.aborted) stop();
                else context.signal.addEventListener("abort", stop, { once: true });
              });
            } finally {
              closed = true;
            }
          })(),
        ),
      }),
      pureAsync,
    );

    const cursor = createMettaAsyncSearchCursor(env, atom("(cancel-pull-v2)"));
    await expect(cursor.next({ maxSteps: 100 })).resolves.toMatchObject({
      kind: "answer",
      value: { atom: sym("first") },
    });
    const reading = cursor.next({ maxSteps: 100 });
    await pulling;
    const closing = cursor.close({ code: "test-prune" });
    await expect(reading).resolves.toMatchObject({
      kind: "cancelled",
      reason: { code: "test-prune" },
    });
    await closing;
    expect(closed).toBe(true);
  });

  it("receives active capabilities, resources, trace, and cancellation", async () => {
    const env = runtime();
    let observed: GroundedCallContextV2 | undefined;
    registerGroundedOperationV2(
      env,
      "context-v2",
      (_args, context) => {
        observed = context;
        return {
          tag: "answers",
          answers: groundedAsyncAnswers(
            (async function* () {
              yield { atom: sym("ok") };
            })(),
          ),
        };
      },
      pureAsync,
    );

    const controller = new AbortController();
    const state = initSt({ resources: { track: true }, signal: controller.signal });
    const results = await mettaEvalAsyncResult(env, atom("(context-v2)"), state);
    expect(results.map(([result]) => format(result))).toEqual(["ok"]);
    expect(observed?.originalArgs).toHaveLength(0);
    expect(observed?.capabilities.has("grounded-exec")).toBe(true);
    expect(observed?.resources.ledger.tracked).toBe(true);
    expect(observed?.trace.traceId).toMatch(/^trace:/);
    controller.abort({ code: "context-test" });
    expect(observed?.signal.aborted).toBe(true);
    expect(observed?.signal.reason).toEqual({ code: "context-test" });
    expect(observed?.resources.closed).toBe(true);
  });
});

async function mettaEvalAsyncResult(
  env: ReturnType<typeof runtime>,
  query: ReturnType<typeof atom>,
  state = initSt(),
) {
  const { mettaEvalAsync } = await import("./eval");
  const [pairs] = await mettaEvalAsync(env, 100_000, state, [], query);
  return pairs;
}
