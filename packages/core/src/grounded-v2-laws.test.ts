// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Executable Grounded V2 protocol laws.
//
// Each law pins one clause of the cursor contract before the implementation is trusted with it:
// adapters own and close every cursor they start, every pull carries a finite allowance, foreign
// events and step reports become typed faults, dispatched answers are not retained by wrapper
// emitters, isolated per-answer worlds are released incrementally, and answer binding cost follows
// the delta size rather than the caller frame size. Laws marked `pin` documented existing behavior
// when they were written; the rest failed first.

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { performance } from "node:perf_hooks";
import { expr, format, gint, gstr, sym } from "./index";
import {
  branchRuntimeSnapshot,
  buildEnv,
  createMettaSearchCursor,
  groundedHostImportV2,
  initSt,
  mettaEval,
  registerGroundedOperationV2,
} from "./eval";
import { composeHostInterops } from "./host";
import { emptyBindingFrame } from "./binding-frame";
import {
  groundedAsyncAnswers,
  groundedSyncAnswers,
  groundedV2AsyncAdapter,
  groundedV2SyncAdapter,
  type GroundedAnswer,
  type GroundedAsyncAnswerCursor,
  type GroundedOperationV2,
  type GroundedOperationV2Options,
  type GroundedOperationV2Registration,
  type GroundedSyncAnswerCursor,
} from "./grounded-v2";
import type { SearchEvent, SearchNextOptions } from "./search-cursor";
import type { CancellationReason } from "./resources";
import { makeValRel, type Bindings } from "./bindings";
import type { Atom } from "./atom";
import { parseAll } from "./parser";
import { preludeAtoms } from "./runner";
import { standardTokenizer } from "./standard-syntax";
import { stdlibAtoms } from "./stdlib";
import { stdTable } from "./builtins";
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

function registration(
  operation: GroundedOperationV2,
  options: GroundedOperationV2Options,
): GroundedOperationV2Registration {
  return { operation, options };
}

function foreignVariable(name: string) {
  return new VariableScope(new RuntimeIdAllocator(`laws-foreign-${name}`).next("scope")).variable(
    name,
  );
}

// `--expose-gc` is not part of the repository test invocation, so the collector handle is taken
// through the documented v8 flag escape hatch instead of a process flag.
function acquireGarbageCollector(): () => void {
  const existing = (globalThis as { gc?: () => void }).gc;
  if (typeof existing === "function") return existing;
  setFlagsFromString("--expose-gc");
  const collect = runInNewContext("gc") as () => void;
  setFlagsFromString("--no-expose-gc");
  return collect;
}

const collectGarbage = acquireGarbageCollector();

async function collectSettledGarbage(): Promise<void> {
  collectGarbage();
  await new Promise((resolve) => setImmediate(resolve));
  collectGarbage();
}

type ScriptedSyncEntry =
  | SearchEvent<GroundedAnswer, void>
  | ((options: SearchNextOptions) => SearchEvent<GroundedAnswer, void>)
  | { readonly raise: unknown };

/** A hand-written cursor that records every pull and close so ownership laws can count them. */
class ScriptedSyncCursor implements GroundedSyncAnswerCursor {
  readonly mode = "sync" as const;
  readonly pullOptions: SearchNextOptions[] = [];
  readonly closeReasons: CancellationReason[] = [];
  #index = 0;
  #closed = false;

  constructor(
    private readonly script: readonly ScriptedSyncEntry[],
    private readonly closeError?: Error,
  ) {}

  get closed(): boolean {
    return this.#closed;
  }

  get pulls(): number {
    return this.pullOptions.length;
  }

  get closeCalls(): number {
    return this.closeReasons.length;
  }

  next(options: SearchNextOptions = {}): SearchEvent<GroundedAnswer, void> {
    this.pullOptions.push(options);
    const entry = this.script[Math.min(this.#index, this.script.length - 1)]!;
    this.#index += 1;
    if (typeof entry === "function") return entry(options);
    if ("raise" in entry) throw entry.raise;
    return entry;
  }

  close(reason: CancellationReason = { code: "closed" }): void {
    this.closeReasons.push(reason);
    this.#closed = true;
    if (this.closeError !== undefined) throw this.closeError;
  }
}

class ScriptedAsyncCursor implements GroundedAsyncAnswerCursor {
  readonly mode = "async" as const;
  readonly pullOptions: SearchNextOptions[] = [];
  readonly closeReasons: CancellationReason[] = [];
  closeSettled = false;
  #index = 0;
  #closed = false;

  constructor(
    private readonly script: readonly ScriptedSyncEntry[],
    private readonly closeError?: Error,
  ) {}

  get closed(): boolean {
    return this.#closed;
  }

  get pulls(): number {
    return this.pullOptions.length;
  }

  get closeCalls(): number {
    return this.closeReasons.length;
  }

  next(options: SearchNextOptions = {}): Promise<SearchEvent<GroundedAnswer, void>> {
    this.pullOptions.push(options);
    const entry = this.script[Math.min(this.#index, this.script.length - 1)]!;
    this.#index += 1;
    if (typeof entry === "function") return Promise.resolve(entry(options));
    if ("raise" in entry) return Promise.reject(entry.raise);
    return Promise.resolve(entry);
  }

  close(reason: CancellationReason = { code: "closed" }): Promise<void> {
    this.closeReasons.push(reason);
    this.#closed = true;
    const closeError = this.closeError;
    return new Promise((resolve, reject) => {
      setImmediate(() => {
        this.closeSettled = true;
        if (closeError !== undefined) reject(closeError);
        else resolve();
      });
    });
  }
}

const answerEvent = (value: Atom, steps = 1): SearchEvent<GroundedAnswer, void> => ({
  kind: "answer",
  value: { atom: value },
  steps,
});

const exhaustedEvent: SearchEvent<GroundedAnswer, void> = {
  kind: "exhausted",
  terminal: undefined,
  steps: 1,
};

describe("Grounded V2 adapter cursor ownership", () => {
  it("closes an async cursor returned by a sync registration", () => {
    const cursor = new ScriptedAsyncCursor([answerEvent(sym("never"))]);
    const adapter = groundedV2SyncAdapter(
      registration(() => ({ tag: "answers", answers: cursor }), pureSync),
    );

    const result = adapter([]);
    expect(result).toMatchObject({ tag: "runtimeError" });
    expect(cursor.pulls).toBe(0);
    expect(cursor.closeCalls).toBe(1);
  });

  it("rejects and closes a sync cursor under an async registration", async () => {
    const cursor = new ScriptedSyncCursor([answerEvent(sym("wrong-mode")), exhaustedEvent]);
    const adapter = groundedV2AsyncAdapter(
      registration(() => ({ tag: "answers", answers: cursor }), pureAsync),
    );

    const result = await adapter([]);
    expect(result).toMatchObject({ tag: "runtimeError" });
    if (result.tag === "runtimeError") expect(result.msg).toMatch(/sync cursor/);
    expect(cursor.pulls).toBe(0);
    expect(cursor.closeCalls).toBe(1);
  });

  it("closes a custom cursor exactly once when a pull throws", () => {
    const cursor = new ScriptedSyncCursor([
      answerEvent(sym("first")),
      { raise: new Error("pull failed") },
    ]);
    const adapter = groundedV2SyncAdapter(
      registration(() => ({ tag: "answers", answers: cursor }), pureSync),
    );

    const result = adapter([]);
    expect(result).toEqual({ tag: "runtimeError", msg: "pull failed" });
    expect(cursor.closeCalls).toBe(1);
  });

  it("combines an initiating pull fault with a distinct close fault", () => {
    const cursor = new ScriptedSyncCursor(
      [{ raise: new Error("pull failed") }],
      new Error("close failed"),
    );
    const adapter = groundedV2SyncAdapter(
      registration(() => ({ tag: "answers", answers: cursor }), pureSync),
    );

    const result = adapter([]);
    expect(result).toMatchObject({ tag: "runtimeError" });
    if (result.tag === "runtimeError") expect(result.msg).toMatch(/both failed/);
    expect(cursor.closeCalls).toBe(1);
  });

  it("reports a malformed event as a typed error instead of skipping it", () => {
    const cursor = new ScriptedSyncCursor([
      { kind: "bogus" } as unknown as SearchEvent<GroundedAnswer, void>,
      exhaustedEvent,
    ]);
    const adapter = groundedV2SyncAdapter(
      registration(() => ({ tag: "answers", answers: cursor }), pureSync),
    );

    const result = adapter([]);
    expect(result).toMatchObject({ tag: "runtimeError" });
    expect(cursor.pulls).toBe(1);
    expect(cursor.closeCalls).toBe(1);
  });

  it("closes a custom cursor that does not close itself on exhaustion", () => {
    const cursor = new ScriptedSyncCursor([answerEvent(sym("only")), exhaustedEvent]);
    const adapter = groundedV2SyncAdapter(
      registration(() => ({ tag: "answers", answers: cursor }), pureSync),
    );

    const result = adapter([]);
    expect(result).toEqual({ tag: "ok", results: [sym("only")] });
    expect(cursor.closeCalls).toBe(1);
  });

  it("joins asynchronous close before the async adapter resolves", async () => {
    const cursor = new ScriptedAsyncCursor([
      answerEvent(sym("first")),
      { raise: new Error("late failure") },
    ]);
    const adapter = groundedV2AsyncAdapter(
      registration(() => ({ tag: "answers", answers: cursor }), pureAsync),
    );

    const result = await adapter([]);
    expect(result).toEqual({ tag: "runtimeError", msg: "late failure" });
    expect(cursor.closeCalls).toBe(1);
    expect(cursor.closeSettled).toBe(true);
  });

  it("bounds every adapter pull with a finite allowance", () => {
    const cursor = new ScriptedSyncCursor([
      answerEvent(sym("a")),
      answerEvent(sym("b")),
      exhaustedEvent,
    ]);
    const adapter = groundedV2SyncAdapter(
      registration(() => ({ tag: "answers", answers: cursor }), pureSync),
    );

    adapter([]);
    expect(cursor.pulls).toBeGreaterThan(0);
    for (const options of cursor.pullOptions) {
      expect(Number.isSafeInteger(options.maxSteps)).toBe(true);
      expect(options.maxSteps!).toBeGreaterThan(0);
    }
  });

  it("rejects a foreign-scope answer variable at the adapter boundary", () => {
    const adapter = groundedV2SyncAdapter(
      registration(
        () => ({
          tag: "answers",
          answers: groundedSyncAnswers([{ atom: foreignVariable("escaped") }]),
        }),
        pureSync,
      ),
    );

    const result = adapter([]);
    expect(result).toMatchObject({ tag: "runtimeError" });
    if (result.tag === "runtimeError") expect(result.msg).toMatch(/foreign/);
  });

  it("rejects a foreign-scope language-error payload at the adapter boundary", () => {
    const adapter = groundedV2SyncAdapter(
      registration(
        () => ({ tag: "language-error", error: expr([sym("Error"), foreignVariable("leak")]) }),
        pureSync,
      ),
    );

    const result = adapter([]);
    expect(result).toMatchObject({ tag: "runtimeError" });
    if (result.tag === "runtimeError") expect(result.msg).toMatch(/foreign/);
  });

  it("rejects foreign-scope effect variables at the adapter boundary", () => {
    const adapter = groundedV2SyncAdapter(
      registration(
        () => ({
          tag: "answers",
          answers: groundedSyncAnswers([
            {
              atom: sym("done"),
              effects: [{ kind: "bindToken", name: "leak", atom: foreignVariable("effect") }],
            },
          ]),
        }),
        { mode: "sync", effects: { classes: ["atomspace-write"], speculative: true } },
      ),
    );

    const result = adapter([]);
    expect(result).toMatchObject({ tag: "runtimeError" });
    if (result.tag === "runtimeError") expect(result.msg).toMatch(/foreign/);
  });
});

describe("Grounded V2 evaluator event validation", () => {
  it("passes a finite allowance on every eager evaluator pull", () => {
    const env = runtime();
    let cursor: ScriptedSyncCursor | undefined;
    registerGroundedOperationV2(
      env,
      "allowance-law-v2",
      () => {
        cursor = new ScriptedSyncCursor([answerEvent(sym("a")), exhaustedEvent]);
        return { tag: "answers", answers: cursor };
      },
      pureSync,
    );

    const [pairs] = mettaEval(env, 100_000, initSt(), [], atom("(allowance-law-v2)"));
    expect(pairs.map(([result]) => format(result))).toEqual(["a"]);
    expect(cursor).toBeDefined();
    expect(cursor!.pulls).toBeGreaterThan(0);
    for (const options of cursor!.pullOptions) {
      expect(Number.isSafeInteger(options.maxSteps)).toBe(true);
      expect(options.maxSteps!).toBeGreaterThan(0);
    }
  });

  it.each([
    ["negative", -1],
    ["NaN", Number.NaN],
    ["infinite", Number.POSITIVE_INFINITY],
    ["unsafe", 2 ** 53],
  ])("turns a %s step report into a typed grounded-next fault", (_label, steps) => {
    const env = runtime();
    registerGroundedOperationV2(
      env,
      "steps-law-v2",
      () => ({
        tag: "answers",
        answers: new ScriptedSyncCursor([answerEvent(sym("a"), steps), exhaustedEvent]),
      }),
      pureSync,
    );

    expect(() => mettaEval(env, 100_000, initSt(), [], atom("(steps-law-v2)"))).toThrowError(
      expect.objectContaining({ kind: "infrastructure-fault", phase: "grounded-next" }),
    );
  });

  it("turns an over-allowance step report into a fault that consumes the allowance", () => {
    const env = runtime();
    registerGroundedOperationV2(
      env,
      "over-allowance-v2",
      () => ({
        tag: "answers",
        answers: new ScriptedSyncCursor([
          (options) => answerEvent(sym("a"), (options.maxSteps ?? 1) + 1),
        ]),
      }),
      pureSync,
    );

    const cursor = createMettaSearchCursor(env, atom("(over-allowance-v2)"));
    let event = cursor.next({ maxSteps: 8 });
    let charged = event.steps;
    while (event.kind === "pending") {
      event = cursor.next({ maxSteps: 8 });
      charged += event.steps;
    }
    expect(event).toMatchObject({
      kind: "fault",
      error: expect.objectContaining({ kind: "infrastructure-fault", phase: "grounded-next" }),
    });
    // The malformed reply consumed the full issued allowance before the fault surfaced.
    expect(charged).toBeGreaterThanOrEqual(8);
    cursor.close();
  });

  it("turns a non-object cursor event into a typed grounded-next fault", () => {
    const env = runtime();
    registerGroundedOperationV2(
      env,
      "null-event-v2",
      () => ({
        tag: "answers",
        answers: new ScriptedSyncCursor([
          () => null as unknown as SearchEvent<GroundedAnswer, void>,
        ]),
      }),
      pureSync,
    );

    expect(() => mettaEval(env, 100_000, initSt(), [], atom("(null-event-v2)"))).toThrowError(
      expect.objectContaining({ kind: "infrastructure-fault", phase: "grounded-next" }),
    );
  });

  it("turns an unknown event kind into a typed grounded-next fault", () => {
    const env = runtime();
    let cursor: ScriptedSyncCursor | undefined;
    registerGroundedOperationV2(
      env,
      "unknown-event-v2",
      () => {
        cursor = new ScriptedSyncCursor([
          { kind: "mystery" } as unknown as SearchEvent<GroundedAnswer, void>,
          exhaustedEvent,
        ]);
        return { tag: "answers", answers: cursor };
      },
      pureSync,
    );

    expect(() => mettaEval(env, 100_000, initSt(), [], atom("(unknown-event-v2)"))).toThrowError(
      expect.objectContaining({ kind: "infrastructure-fault", phase: "grounded-next" }),
    );
    expect(cursor!.pulls).toBe(1);
  });

  it("closes the custom cursor when the evaluator faults on its event", () => {
    const env = runtime();
    let cursor: ScriptedSyncCursor | undefined;
    registerGroundedOperationV2(
      env,
      "fault-close-v2",
      () => {
        cursor = new ScriptedSyncCursor([{ raise: new Error("pull exploded") }]);
        return { tag: "answers", answers: cursor };
      },
      pureSync,
    );

    expect(() => mettaEval(env, 100_000, initSt(), [], atom("(fault-close-v2)"))).toThrowError(
      expect.objectContaining({ kind: "infrastructure-fault", phase: "grounded-next" }),
    );
    expect(cursor!.closeCalls).toBe(1);
  });

  it("reports the mode fault and initiates close for a wrong-mode cursor in sync evaluation", () => {
    const env = runtime();
    let cursor: ScriptedAsyncCursor | undefined;
    registerGroundedOperationV2(
      env,
      "wrong-mode-close-v2",
      () => {
        cursor = new ScriptedAsyncCursor([answerEvent(sym("never"))]);
        return { tag: "answers", answers: cursor };
      },
      pureSync,
    );

    expect(() => mettaEval(env, 100_000, initSt(), [], atom("(wrong-mode-close-v2)"))).toThrowError(
      expect.objectContaining({
        kind: "infrastructure-fault",
        phase: "grounded-start",
        message: expect.stringMatching(/returned async cursor/),
      }),
    );
    expect(cursor!.pulls).toBe(0);
    expect(cursor!.closeCalls).toBe(1);
  });

  // pin: the evaluator already combined pull and close failures when this law was written.
  it("combines an evaluator pull fault with a distinct producer cleanup fault", () => {
    const env = runtime();
    registerGroundedOperationV2(
      env,
      "combined-fault-v2",
      () => ({
        tag: "answers",
        answers: new ScriptedSyncCursor(
          [{ raise: new Error("pull failed") }],
          new Error("close failed"),
        ),
      }),
      pureSync,
    );

    expect(() => mettaEval(env, 100_000, initSt(), [], atom("(combined-fault-v2)"))).toThrowError(
      expect.objectContaining({ message: expect.stringMatching(/both failed/) }),
    );
  });

  // pin: diagnostics carry the exact instantiated call as their subject.
  it("names the exact original call subject in capability diagnostics", () => {
    const env = runtime();
    registerGroundedOperationV2(
      env,
      "subject-law-v2",
      () => ({ tag: "answers", answers: groundedSyncAnswers([]) }),
      { ...pureSync, requiredCapabilities: ["subject-law-capability"] },
    );

    let observed: unknown;
    try {
      mettaEval(env, 100_000, initSt(), [], atom("(subject-law-v2 payload)"));
    } catch (error) {
      observed = error;
    }
    expect(observed).toMatchObject({ kind: "infrastructure-fault", phase: "grounded-capability" });
    const subject = (observed as { subject?: Atom }).subject;
    expect(subject).toBeDefined();
    expect(format(subject!)).toBe("(subject-law-v2 payload)");
  });
});

const RETENTION_ANSWERS = 64;
const RETENTION_PULLS = 48;
const RETENTION_CHECKED = 32;

interface RetentionProbe {
  readonly env: ReturnType<typeof runtime>;
  readonly refs: WeakRef<object>[];
  produced(): number;
  closedCount(): number;
}

function retentionRuntime(name: string): RetentionProbe {
  const env = runtime();
  const refs: WeakRef<object>[] = [];
  let produced = 0;
  let closed = 0;
  registerGroundedOperationV2(
    env,
    name,
    () => ({
      tag: "answers",
      answers: groundedSyncAnswers(
        (function* (): Generator<GroundedAnswer> {
          try {
            for (let index = 0; index < RETENTION_ANSWERS; index += 1) {
              produced += 1;
              const payload = expr([sym("payload"), gint(index)]);
              refs.push(new WeakRef(payload));
              yield { atom: payload };
            }
          } finally {
            closed += 1;
          }
        })(),
      ),
    }),
    pureSync,
  );
  return { env, refs, produced: () => produced, closedCount: () => closed };
}

async function survivorsAfterPartialDrain(probe: RetentionProbe, source: string): Promise<number> {
  const cursor = createMettaSearchCursor(probe.env, atom(source));
  let pulled = 0;
  while (pulled < RETENTION_PULLS) {
    const event = cursor.next({ maxSteps: 100_000 });
    if (event.kind === "answer") pulled += 1;
    else if (event.kind !== "pending") throw new Error(`unexpected ${event.kind} event`);
  }
  await collectSettledGarbage();
  const survivors = probe.refs
    .slice(0, RETENTION_CHECKED)
    .filter((ref) => ref.deref() !== undefined).length;
  cursor.close();
  return survivors;
}

describe("Grounded V2 streamed answer retention", () => {
  // pin: the direct root stream already omitted its returned answer bag; this validates the
  // WeakRef instrument before the wrapper laws rely on it.
  it("drops dispatched answers at the direct streaming root", async () => {
    const probe = retentionRuntime("retention-root-v2");
    await expect(survivorsAfterPartialDrain(probe, "(retention-root-v2)")).resolves.toBe(0);
  });

  it("drops dispatched answers under a streamed superpose wrapper", async () => {
    const probe = retentionRuntime("retention-superpose-v2");
    await expect(
      survivorsAfterPartialDrain(probe, "(superpose ((retention-superpose-v2)))"),
    ).resolves.toBe(0);
  });

  it("drops dispatched answers under a streamed hyperpose wrapper", async () => {
    const probe = retentionRuntime("retention-hyperpose-v2");
    await expect(
      survivorsAfterPartialDrain(probe, "(hyperpose ((retention-hyperpose-v2)))"),
    ).resolves.toBe(0);
  });

  it("drops dispatched answers streamed through an applicative argument position", async () => {
    const probe = retentionRuntime("retention-argument-v2");
    probe.env.gt.set("first-arg-law", (args) => ({ tag: "ok", results: [args[0]!] }));
    await expect(
      survivorsAfterPartialDrain(probe, "(first-arg-law (retention-argument-v2))"),
    ).resolves.toBe(0);
  });

  it("lets once close an unvisited superpose-wrapped grounded tail", () => {
    const env = runtime();
    let produced = 0;
    let closed = 0;
    const total = 8_192;
    registerGroundedOperationV2(
      env,
      "once-superpose-v2",
      () => ({
        tag: "answers",
        answers: groundedSyncAnswers(
          (function* (): Generator<GroundedAnswer> {
            try {
              for (let index = 0; index < total; index += 1) {
                produced += 1;
                yield { atom: expr([sym("payload"), gint(index)]) };
              }
            } finally {
              closed += 1;
            }
          })(),
        ),
      }),
      pureSync,
    );

    const [pairs] = mettaEval(
      env,
      1_000_000,
      initSt(),
      [],
      atom("(once (superpose ((once-superpose-v2))))"),
    );
    expect(pairs.map(([result]) => format(result))).toEqual(["(payload 0)"]);
    // One cooperative pull may batch up to its step quantum, but once must prune the tail
    // instead of enumerating it, and the producer must be closed exactly once.
    expect(produced).toBeLessThan(1_024);
    expect(closed).toBe(1);
  });
});

const ISOLATION_SAMPLE_EVERY = 256;

async function isolatedStreamingHeapGrowth(answers: number): Promise<number> {
  const env = runtime();
  registerGroundedOperationV2(
    env,
    "isolated-heap-v2",
    () => ({
      tag: "answers",
      answers: groundedSyncAnswers(
        (function* (): Generator<GroundedAnswer> {
          for (let index = 0; index < answers; index += 1)
            yield { atom: expr([sym("iso"), gint(index)]) };
        })(),
      ),
    }),
    pureSync,
  );

  const cursor = createMettaSearchCursor(env, atom("(hyperpose ((isolated-heap-v2)))"));
  await collectSettledGarbage();
  const base = process.memoryUsage().heapUsed;
  let peakGrowth = 0;
  let pulled = 0;
  for (;;) {
    const event = cursor.next({ maxSteps: 1_000_000 });
    if (event.kind === "answer") {
      pulled += 1;
      if (pulled % ISOLATION_SAMPLE_EVERY === 0) {
        collectGarbage();
        peakGrowth = Math.max(peakGrowth, process.memoryUsage().heapUsed - base);
      }
      continue;
    }
    if (event.kind === "exhausted") break;
    if (event.kind !== "pending") throw new Error(`unexpected ${event.kind} event`);
  }
  expect(pulled).toBe(answers);
  cursor.close();
  return peakGrowth;
}

describe("Grounded V2 isolated streaming retention", () => {
  it("keeps live isolated branch state bounded while answers stream", async () => {
    const small = await isolatedStreamingHeapGrowth(2_048);
    const large = await isolatedStreamingHeapGrowth(8_192);
    // A per-answer retained branch or terminal world makes peak growth scale with the answer
    // count (measured ~2.4 KiB per answer, so 4x answers reads ~4x growth); incremental release
    // keeps the two peaks within allocator noise of each other.
    expect(large).toBeLessThan(Math.max(small * 2, small + 2 * 1024 * 1024));
  }, 60_000);
});

function widecallerBindings(size: number): Bindings {
  const relations = [];
  for (let index = 0; index < size; index += 1)
    relations.push(makeValRel(`caller${index}`, expr([sym("val"), gint(index)])));
  relations.push(makeValRel("x", sym("seed")));
  return relations;
}

describe("Grounded V2 binding answer cost", () => {
  interface AnswerCountBox {
    count: number;
  }

  function registerDeltaLaw(
    env: ReturnType<typeof runtime>,
    bindEveryAnswer: boolean,
    box: AnswerCountBox,
  ): void {
    registerGroundedOperationV2(
      env,
      "delta-law-v2",
      (_args, context) => {
        const output = context.visibleVariables[0];
        if (output === undefined)
          return { tag: "language-error", error: gstr("one visible variable required") };
        return {
          tag: "answers",
          answers: groundedSyncAnswers(
            (function* (): Generator<GroundedAnswer> {
              for (let index = 0; index < box.count; index += 1) {
                if (!bindEveryAnswer) {
                  yield { atom: gint(index) };
                  continue;
                }
                const bound = context.bindings.bind(output, gint(index));
                if (!bound.ok) throw new Error(bound.fault.message);
                yield { atom: output, bindingDelta: bound.value };
              }
            })(),
          ),
        };
      },
      pureSync,
    );
  }

  function medianDeltaCallMs(
    env: ReturnType<typeof runtime>,
    box: AnswerCountBox,
    callerSize: number,
    answers: number,
  ): number {
    const samples: number[] = [];
    for (let run = 0; run < 3; run += 1) {
      const bindings = widecallerBindings(callerSize);
      box.count = answers;
      const begin = performance.now();
      const [pairs] = mettaEval(env, 1_000_000, initSt(), bindings, atom("(delta-law-v2 $y)"));
      samples.push(performance.now() - begin);
      expect(pairs).toHaveLength(answers);
    }
    samples.sort((a, b) => a - b);
    return samples[1]!;
  }

  const FEW_ANSWERS = 8;
  const MANY_ANSWERS = 520;

  /**
   * The per-answer marginal cost at one caller-frame size. Subtracting the few-answer call
   * removes the legitimate once-per-call frame conversion, projection, and evaluator overhead,
   * which grow with `B` and would otherwise mask the per-answer term this law constrains.
   */
  function marginalAnswerMs(
    env: ReturnType<typeof runtime>,
    box: AnswerCountBox,
    callerSize: number,
  ): number {
    medianDeltaCallMs(env, box, callerSize, FEW_ANSWERS);
    const few = medianDeltaCallMs(env, box, callerSize, FEW_ANSWERS);
    const many = medianDeltaCallMs(env, box, callerSize, MANY_ANSWERS);
    return (many - few) / (MANY_ANSWERS - FEW_ANSWERS);
  }

  // pin: wide caller frames stay semantically exact regardless of representation.
  it("keeps answers exact under a wide caller frame", () => {
    const env = runtime();
    const box: AnswerCountBox = { count: 64 };
    registerDeltaLaw(env, true, box);
    const [pairs] = mettaEval(
      env,
      1_000_000,
      initSt(),
      widecallerBindings(800),
      atom("(delta-law-v2 $y)"),
    );
    expect(pairs).toHaveLength(64);
    expect(pairs.slice(0, 3).map(([result]) => format(result))).toEqual(["0", "1", "2"]);
  });

  it("scales per-answer binding deltas with the delta, not the caller frame", () => {
    const env = runtime();
    const box: AnswerCountBox = { count: 0 };
    registerDeltaLaw(env, true, box);
    const narrow = marginalAnswerMs(env, box, 512);
    const wide = marginalAnswerMs(env, box, 2_048);
    // O(N*B) makes the marginal answer cost track the caller frame (a 4x frame reads ~4x);
    // O(D log B) keeps the marginal within log-factor noise of the narrow frame.
    expect(wide).toBeLessThan(Math.max(narrow * 2.5, narrow + 0.005));
  }, 60_000);

  it("scales zero-delta answers with the answer count, not the caller frame", () => {
    const env = runtime();
    const box: AnswerCountBox = { count: 0 };
    registerDeltaLaw(env, false, box);
    const narrow = marginalAnswerMs(env, box, 512);
    const wide = marginalAnswerMs(env, box, 2_048);
    expect(wide).toBeLessThan(Math.max(narrow * 2.5, narrow + 0.005));
  }, 60_000);
});

describe("Grounded V2 evaluator scope authority", () => {
  function registerForeign(env: ReturnType<typeof runtime>, start: () => unknown): void {
    registerGroundedOperationV2(env, "foreign-law-v2", start as never, {
      mode: "sync",
      effects: { classes: ["atomspace-write"], speculative: true },
    });
  }

  it.each([
    [
      "answer binding-delta member",
      (): unknown => {
        const foreign = foreignVariable("member");
        const bound = emptyBindingFrame.bind(foreign, sym("leak"));
        if (!bound.ok) throw new Error(bound.fault.message);
        return {
          tag: "answers",
          answers: groundedSyncAnswers([{ atom: sym("x"), bindingDelta: bound.value }]),
        };
      },
    ],
    [
      "answer binding-delta value",
      (): unknown => {
        const carrier = foreignVariable("carrier");
        const bound = emptyBindingFrame.bind(carrier, expr([sym("v"), foreignVariable("value")]));
        if (!bound.ok) throw new Error(bound.fault.message);
        return {
          tag: "answers",
          answers: groundedSyncAnswers([{ atom: sym("x"), bindingDelta: bound.value }]),
        };
      },
    ],
    [
      "pre-effect atom",
      (): unknown => ({
        tag: "answers",
        preEffects: [{ kind: "bindToken", name: "leak", atom: foreignVariable("pre") }],
        answers: groundedSyncAnswers([]),
      }),
    ],
    [
      "per-answer effect atom",
      (): unknown => ({
        tag: "answers",
        answers: groundedSyncAnswers([
          {
            atom: sym("x"),
            effects: [{ kind: "bindToken", name: "leak", atom: foreignVariable("effect") }],
          },
        ]),
      }),
    ],
    [
      "language-error payload",
      (): unknown => ({
        tag: "language-error",
        error: expr([sym("Error"), foreignVariable("error")]),
      }),
    ],
  ])("rejects a foreign-scope variable in a %s", (_label, start) => {
    const env = runtime();
    registerForeign(env, start);
    expect(() => mettaEval(env, 100_000, initSt(), [], atom("(foreign-law-v2)"))).toThrowError(
      expect.objectContaining({ kind: "infrastructure-fault", phase: "grounded-bindings" }),
    );
  });

  it("charges answer, binding, and effect atoms at publication", () => {
    const env = runtime();
    registerGroundedOperationV2(
      env,
      "charged-v2",
      (_args, context) => {
        const output = context.visibleVariables[0]!;
        const bound = context.bindings.bind(output, expr([sym("val"), sym("deep")]));
        if (!bound.ok) throw new Error(bound.fault.message);
        return {
          tag: "answers",
          answers: groundedSyncAnswers([
            {
              atom: output,
              bindingDelta: bound.value,
              effects: [{ kind: "bindToken", name: "token", atom: expr([sym("eff"), sym("x")]) }],
            },
          ]),
        };
      },
      { mode: "sync", effects: { classes: ["atomspace-write"], speculative: true } },
    );

    const state = initSt({ resources: { track: true } });
    const cursor = createMettaSearchCursor(env, atom("(charged-v2 $y)"), { state });
    const first = cursor.next({ maxSteps: 100_000 });
    expect(first.kind).toBe("answer");
    if (first.kind !== "answer") throw new Error("expected an answer");
    const used = branchRuntimeSnapshot(first.value.state).resources.used;
    expect(used.results).toBe(1);
    // Answer atom (val deep) = 3 cells and effect atom (eff x) = 3 cells; the published binding
    // value instantiates to the same (val deep) structure, so unique-cell counting dedupes it.
    // The exact count pins the publication-time debit against silent collection-time accounting.
    expect(used["atom-cells"]).toBe(6);
    cursor.close();
  });
});

describe("Grounded V2 host composition contracts", () => {
  it("promotes a sync candidate under an async composition", async () => {
    const env = runtime();
    const skipped = groundedHostImportV2(() => ({ tag: "stuck" }), pureSync);
    const selected = groundedHostImportV2(
      async () => ({
        tag: "answers",
        answers: groundedAsyncAnswers(
          (async function* (): AsyncGenerator<GroundedAnswer> {
            yield { atom: sym("mixed-mode") };
          })(),
        ),
      }),
      pureAsync,
    );
    env.hostImport = composeHostInterops([
      { name: "sync-first", hostImport: skipped },
      { name: "async-second", hostImport: selected },
    ]).hostImport!;

    const { mettaEvalAsync } = await import("./eval");
    const [pairs] = await mettaEvalAsync(env, 100_000, initSt(), [], atom('(import! &self "m")'));
    expect(pairs.map(([result]) => format(result))).toEqual(["mixed-mode"]);
  });

  it("falls back to candidate-level dispatch when effect contracts differ", () => {
    const env = runtime();
    const skipped = groundedHostImportV2(() => ({ tag: "stuck" }), pureSync);
    const selected = groundedHostImportV2(
      () => ({ tag: "answers", answers: groundedSyncAnswers([{ atom: sym("effectful") }]) }),
      { mode: "sync", effects: { classes: ["atomspace-write"], speculative: true } },
    );
    const composed = composeHostInterops([
      { name: "pure", hostImport: skipped },
      { name: "writer", hostImport: selected },
    ]);
    env.hostImport = composed.hostImport!;

    const [pairs] = mettaEval(env, 100_000, initSt(), [], atom('(import! &self "m")'));
    expect(pairs.map(([result]) => format(result))).toEqual(["effectful"]);
  });

  it("closes each candidate cursor exactly once through the composed drain", () => {
    const cursor = new ScriptedSyncCursor([answerEvent(sym("one")), exhaustedEvent]);
    const selected = groundedHostImportV2(() => ({ tag: "answers", answers: cursor }), pureSync);
    const composed = composeHostInterops([{ name: "only", hostImport: selected }]);
    const env = runtime();
    env.hostImport = composed.hostImport!;

    const [pairs] = mettaEval(env, 100_000, initSt(), [], atom('(import! &self "m")'));
    expect(pairs.map(([result]) => format(result))).toEqual(["one"]);
    expect(cursor.closeCalls).toBe(1);
  });

  it("turns a cancelled cursor event into a typed error and closes once", () => {
    const cursor = new ScriptedSyncCursor([
      answerEvent(sym("first")),
      { kind: "cancelled", reason: { code: "external" }, steps: 1 } as SearchEvent<
        GroundedAnswer,
        void
      >,
    ]);
    const adapter = groundedV2SyncAdapter(
      registration(() => ({ tag: "answers", answers: cursor }), pureSync),
    );

    const result = adapter([]);
    expect(result).toMatchObject({ tag: "runtimeError" });
    expect(cursor.closeCalls).toBe(1);
  });
});

describe("Grounded V2 streamed tuple parity", () => {
  function tupleRuntime() {
    const env = buildEnv(
      [
        ...preludeAtoms(),
        ...stdlibAtoms(),
        ...parseAll(
          "(= (choice) 1) (= (choice) 2) (= (bindq 7) marked) (= (boom) (Error boom bad))",
          standardTokenizer(),
        ).map((parsed) => parsed.atom),
      ],
      stdTable(),
    );
    registerGroundedOperationV2(
      env,
      "gen3-v2",
      () => ({
        tag: "answers",
        answers: groundedSyncAnswers([
          { atom: sym("ga") },
          { atom: sym("gb") },
          { atom: sym("gc") },
        ]),
      }),
      pureSync,
    );
    return env;
  }

  function drainCursor(env: ReturnType<typeof runtime>, source: string): string[] {
    const cursor = createMettaSearchCursor(env, atom(source));
    const answers: string[] = [];
    for (;;) {
      const event = cursor.next({ maxSteps: 1_000_000 });
      if (event.kind === "answer") {
        answers.push(format(event.value.atom));
        continue;
      }
      if (event.kind === "exhausted") break;
      if (event.kind === "cancelled" || event.kind === "fault")
        throw new Error(`unexpected ${event.kind} event`);
    }
    cursor.close();
    return answers;
  }

  const TUPLE_SHAPES = [
    "()",
    "(1 2)",
    "((choice))",
    "((choice) (choice))",
    "((gen3-v2) (choice))",
    "((choice) (gen3-v2) 9)",
    "((boom) (choice))",
    "((bindq $q) $q)",
    "(((choice) 1) (gen3-v2))",
    "(superpose ((gen3-v2)))",
    "(superpose ((choice) (gen3-v2)))",
    "(collapse (gen3-v2))",
  ];

  it.each(TUPLE_SHAPES)("streams %s with the same answers as eager evaluation", (source) => {
    const eagerEnv = tupleRuntime();
    const [eager] = mettaEval(eagerEnv, 1_000_000, initSt(), [], atom(source));
    const streamed = drainCursor(tupleRuntime(), source);
    expect(streamed).toEqual(eager.map(([result]) => format(result)));
  });

  it("streams randomized tuple compositions with eager parity", () => {
    const item = fc.oneof(
      fc.integer({ min: 0, max: 9 }).map((value) => String(value)),
      fc.constantFrom("a", "(choice)", "(gen3-v2)", "(boom)"),
    );
    fc.assert(
      fc.property(
        fc.array(item, { maxLength: 3 }),
        fc.array(item, { maxLength: 2 }),
        (outer, inner) => {
          const source = `(${[...outer, `(${inner.join(" ")})`].join(" ")})`;
          const eagerEnv = tupleRuntime();
          const [eager] = mettaEval(eagerEnv, 1_000_000, initSt(), [], atom(source));
          const streamed = drainCursor(tupleRuntime(), source);
          expect(streamed).toEqual(eager.map(([result]) => format(result)));
        },
      ),
      { numRuns: 60 },
    );
  }, 60_000);
});

describe("Grounded V2 randomized delta equivalence", () => {
  it("matches directly computed answers for arbitrary finite delta scripts", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            value: fc.integer({ min: -1_000, max: 1_000 }),
            bind: fc.boolean(),
          }),
          { maxLength: 24 },
        ),
        (script) => {
          const env = runtime();
          registerGroundedOperationV2(
            env,
            "random-delta-v2",
            (_args, context) => {
              const output = context.visibleVariables[0]!;
              return {
                tag: "answers",
                answers: groundedSyncAnswers(
                  (function* (): Generator<GroundedAnswer> {
                    for (const step of script) {
                      if (!step.bind) {
                        yield { atom: gint(step.value) };
                        continue;
                      }
                      const bound = context.bindings.bind(output, gint(step.value));
                      if (!bound.ok) throw new Error(bound.fault.message);
                      yield { atom: output, bindingDelta: bound.value };
                    }
                  })(),
                ),
              };
            },
            pureSync,
          );

          const [pairs] = mettaEval(env, 100_000, initSt(), [], atom("(random-delta-v2 $x)"));
          expect(pairs.map(([result]) => format(result))).toEqual(
            script.map((step) => String(step.value)),
          );
        },
      ),
      { numRuns: 40 },
    );
  });

  it("matches the async adapter against the sync adapter for the same script", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.integer(), { maxLength: 16 }), async (values) => {
        const answers = () => values.map((value): GroundedAnswer => ({ atom: gint(value) }));
        const sync = groundedV2SyncAdapter(
          registration(
            () => ({ tag: "answers", answers: groundedSyncAnswers(answers()) }),
            pureSync,
          ),
        );
        const async = groundedV2AsyncAdapter(
          registration(
            () => ({
              tag: "answers",
              answers: groundedAsyncAnswers(
                (async function* (): AsyncGenerator<GroundedAnswer> {
                  for (const answer of answers()) yield answer;
                })(),
              ),
            }),
            pureAsync,
          ),
        );

        expect(await async([])).toEqual(sync([]));
      }),
      { numRuns: 25 },
    );
  });
});
