// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { type Atom, expr, gint, sym, variable } from "./atom";
import { BAIL, type Skel, type SkelBody, type SkelClause } from "./compile";
import { compileJitGroup, jitRuntime, type JitGroup } from "./nondet-jit";
import { format } from "./parser";

const constant = (name: string): Skel => ({ t: 0, a: sym(name) });
const integer = (value: number): Skel => ({ t: 0, a: gint(value) });
const slot = (i: number): Skel => ({ t: 1, i });
const node = (...items: Skel[]): Skel => ({ t: 2, items, arith: undefined });
const add = (left: Skel, right: Skel): Skel => ({
  t: 2,
  items: [constant("+"), left, right],
  arith: "+",
});
const sub = (left: Skel, right: Skel): Skel => ({
  t: 2,
  items: [constant("-"), left, right],
  arith: "-",
});
const template = (tpl: Skel): SkelBody => ({ tag: "seq", goals: [], tail: { tag: "tpl", tpl } });
const callThen = (pat: Skel, args: readonly Skel[], tpl: Skel, fn = "source"): SkelBody => ({
  tag: "seq",
  goals: [{ pat, fn, args }],
  tail: { tag: "tpl", tpl },
});

function run(jit: JitGroup, fn: string, args: readonly Atom[], cap = 1_000): string[] {
  const cells = new Map<string, ReturnType<typeof jitRuntime.mkc>>();
  const slimArgs = args.map((arg) => jitRuntime.slimOfAtom(arg, cells));
  const namer = { c: 0 };
  const out: string[] = [];
  jit.call(fn, slimArgs, (result) => out.push(format(jitRuntime.atomOfSlim(result, namer))), {
    c: 0,
    d: 0,
    cap,
    active: [],
  });
  return out;
}

function runDeferred(jit: JitGroup, fn: string, args: readonly Atom[]): string[] | undefined {
  const cells = new Map<string, ReturnType<typeof jitRuntime.mkc>>();
  const slimArgs = args.map((arg) => jitRuntime.slimOfAtom(arg, cells));
  const namer = { c: 0 };
  const out: string[] = [];
  const admitted = jit.tryDeferred?.(
    fn,
    slimArgs,
    (result) => out.push(format(jitRuntime.atomOfSlim(result, namer))),
    { c: 0, d: 0, cap: 1_000, active: [] },
  );
  return admitted === true ? out : undefined;
}

function thrownBy(run: () => void): unknown {
  try {
    run();
  } catch (cause) {
    return cause;
  }
  return undefined;
}

function compileSourceProbe(
  source: readonly SkelClause[],
  probe: readonly SkelClause[],
  sourceArity: number,
): JitGroup {
  return compileJitGroup(
    new Map([
      ["source", source],
      ["probe", probe],
    ]),
    new Map([
      ["source", sourceArity],
      ["probe", 0],
    ]),
    BAIL,
  )!;
}

describe("nondeterministic JIT structural factorization", () => {
  it("factorizes an independent recursive constructor output", () => {
    const output = (size: Skel, trace: Skel): Skel => node(constant("Out"), size, trace);
    const step = (child: Skel): Skel => node(constant("Step"), child);
    const walk: SkelClause[] = [
      {
        n: 0,
        lhsArgs: [integer(0), constant("leaf")],
        body: template(output(integer(0), constant("leaf"))),
      },
      {
        n: 3,
        lhsArgs: [slot(0), step(slot(1))],
        body: {
          tag: "if",
          op: ">",
          x: slot(0),
          y: integer(0),
          then: {
            tag: "seq",
            goals: [
              {
                pat: output(slot(2), slot(1)),
                fn: "walk",
                args: [sub(slot(0), integer(1)), slot(1)],
              },
            ],
            tail: { tag: "tpl", tpl: output(slot(0), step(slot(1))) },
          },
          els: { tag: "seq", goals: [], tail: { tag: "empty" } },
        },
      },
    ];
    const jit = compileJitGroup(new Map([["walk", walk]]), new Map([["walk", 2]]), BAIL)!;
    const args = [gint(4), variable("trace")];

    expect(runDeferred(jit, "walk", args)).toEqual(["(Out 4 (Step (Step (Step (Step leaf)))))"]);
    expect(run(jit, "walk", args)).toEqual(runDeferred(jit, "walk", args));
    expect(runDeferred(jit, "walk", [gint(4), sym("leaf")])).toBeUndefined();
  });

  it("specializes a generalized control table to the consumed call", () => {
    const request = (kind: Skel, witness: Skel): Skel => node(constant("Request"), kind, witness);
    const output = (kind: Skel, witness: Skel): Skel => node(constant("Out"), kind, witness);
    const pick: SkelClause[] = [
      {
        n: 1,
        lhsArgs: [slot(0), request(constant("a"), constant("proof-a"))],
        body: template(output(constant("result-a"), constant("proof-a"))),
      },
      {
        n: 1,
        lhsArgs: [slot(0), request(constant("b"), constant("proof-b"))],
        body: template(output(constant("result-b"), constant("proof-b"))),
      },
    ];
    const jit = compileJitGroup(new Map([["pick", pick]]), new Map([["pick", 2]]), BAIL)!;
    const args = [gint(0), expr([sym("Request"), sym("a"), variable("proof")])];

    expect(runDeferred(jit, "pick", args)).toEqual(["(Out result-a proof-a)"]);
    expect(runDeferred(jit, "pick", args)).toEqual(run(jit, "pick", args));
  });

  it("preserves duplicate left-major products in a deferred recursive witness", () => {
    const request = (witness: Skel): Skel => node(constant("Request"), witness);
    const output = (size: Skel, witness: Skel): Skel => node(constant("Out"), size, witness);
    const pair = (left: Skel, right: Skel): Skel => node(constant("Pair"), left, right);
    const tree: SkelClause[] = [
      {
        n: 1,
        lhsArgs: [slot(0), request(constant("a"))],
        body: template(output(slot(0), constant("a"))),
      },
      {
        n: 1,
        lhsArgs: [slot(0), request(constant("a"))],
        body: template(output(slot(0), constant("a"))),
      },
      {
        n: 1,
        lhsArgs: [slot(0), request(constant("b"))],
        body: template(output(slot(0), constant("b"))),
      },
      {
        n: 4,
        lhsArgs: [slot(0), request(pair(slot(1), slot(2)))],
        body: {
          tag: "if",
          op: ">",
          x: slot(0),
          y: integer(0),
          then: {
            tag: "seq",
            goals: [
              {
                pat: output(slot(3), slot(1)),
                fn: "tree",
                args: [sub(slot(0), integer(1)), request(slot(1))],
              },
              {
                pat: output(slot(3), slot(2)),
                fn: "tree",
                args: [sub(slot(0), integer(1)), request(slot(2))],
              },
            ],
            tail: { tag: "tpl", tpl: output(slot(0), pair(slot(1), slot(2))) },
          },
          els: { tag: "seq", goals: [], tail: { tag: "empty" } },
        },
      },
    ];
    const jit = compileJitGroup(new Map([["tree", tree]]), new Map([["tree", 2]]), BAIL)!;
    const args = [gint(1), expr([sym("Request"), variable("witness")])];
    const direct = run(jit, "tree", args);

    expect(direct).toEqual([
      "(Out 1 a)",
      "(Out 1 a)",
      "(Out 1 b)",
      "(Out 1 (Pair a a))",
      "(Out 1 (Pair a a))",
      "(Out 1 (Pair a b))",
      "(Out 1 (Pair a a))",
      "(Out 1 (Pair a a))",
      "(Out 1 (Pair a b))",
      "(Out 1 (Pair b a))",
      "(Out 1 (Pair b a))",
      "(Out 1 (Pair b b))",
    ]);
    expect(runDeferred(jit, "tree", args)).toEqual(direct);
  });

  it("replays every factored result field from a generalized frontier row", () => {
    const sized = (size: Skel, payload: Skel): Skel => node(constant("Sized"), size, payload);
    const wrapped = (payload: Skel): Skel => node(constant("Wrapped"), payload);
    const countdown: SkelClause[] = [
      {
        n: 3,
        lhsArgs: [slot(0), wrapped(slot(1))],
        body: {
          tag: "if",
          op: ">",
          x: slot(0),
          y: integer(0),
          then: {
            tag: "seq",
            goals: [
              {
                pat: sized(slot(2), slot(1)),
                fn: "countdown",
                args: [sub(slot(0), integer(1)), wrapped(slot(1))],
              },
            ],
            tail: { tag: "tpl", tpl: sized(add(slot(2), integer(1)), slot(1)) },
          },
          els: template(sized(integer(0), slot(1))),
        },
      },
    ];
    const jit = compileJitGroup(
      new Map([["countdown", countdown]]),
      new Map([["countdown", 2]]),
      BAIL,
      true,
    )!;
    const cells = new Map<string, ReturnType<typeof jitRuntime.mkc>>();
    const args = [gint(8), expr([sym("Wrapped"), sym("payload")])].map((arg) =>
      jitRuntime.slimOfAtom(arg, cells),
    );
    const state = { c: 0, d: 0, cap: 1_000, active: [] };

    expect(jit.prepareFrontier?.("countdown", args, state)).toBe(true);
    const out: string[] = [];
    const namer = { c: 0 };
    jit.call(
      "countdown",
      args,
      (result) => out.push(format(jitRuntime.atomOfSlim(result, namer))),
      state,
    );

    expect(out).toEqual(["(Sized 8 payload)"]);
  });

  it("admits finite sibling breadth beyond the speculative call hedge", () => {
    const source: SkelClause[] = [{ n: 0, lhsArgs: [], body: template(constant("ok")) }];
    const root: SkelClause[] = [
      {
        n: 0,
        lhsArgs: [],
        body: {
          tag: "seq",
          goals: [
            { pat: constant("ok"), fn: "source", args: [] },
            { pat: constant("ok"), fn: "source", args: [] },
          ],
          tail: { tag: "tpl", tpl: constant("done") },
        },
      },
    ];
    const jit = compileJitGroup(
      new Map([
        ["source", source],
        ["root", root],
      ]),
      new Map([
        ["source", 0],
        ["root", 0],
      ]),
      BAIL,
    )!;

    expect(run(jit, "root", [], 1)).toEqual(["done"]);
  });

  it("admits over-hedge recursion with a decreasing natural argument", () => {
    const down: SkelClause[] = [
      {
        n: 1,
        lhsArgs: [slot(0)],
        body: {
          tag: "if",
          op: ">",
          x: slot(0),
          y: integer(0),
          then: {
            tag: "seq",
            goals: [],
            tail: { tag: "call", fn: "down", args: [sub(slot(0), integer(1))] },
          },
          els: template(constant("done")),
        },
      },
    ];
    const jit = compileJitGroup(new Map([["down", down]]), new Map([["down", 1]]), BAIL)!;

    expect(run(jit, "down", [gint(5)], 1)).toEqual(["done"]);
  });

  it("admits a mutually recursive cycle whose natural tuple decreases per round", () => {
    const left: SkelClause[] = [
      {
        n: 1,
        lhsArgs: [slot(0)],
        body: {
          tag: "seq",
          goals: [],
          tail: { tag: "call", fn: "right", args: [slot(0)] },
        },
      },
    ];
    const right: SkelClause[] = [
      {
        n: 1,
        lhsArgs: [slot(0)],
        body: {
          tag: "if",
          op: ">",
          x: slot(0),
          y: integer(0),
          then: {
            tag: "seq",
            goals: [],
            tail: { tag: "call", fn: "left", args: [sub(slot(0), integer(1))] },
          },
          els: template(constant("done")),
        },
      },
    ];
    const jit = compileJitGroup(
      new Map([
        ["left", left],
        ["right", right],
      ]),
      new Map([
        ["left", 1],
        ["right", 1],
      ]),
      BAIL,
    )!;

    expect(run(jit, "left", [gint(5)], 1)).toEqual(["done"]);
  });

  it("rejects an over-hedge active recurrence without strict descent", () => {
    const loop: SkelClause[] = [
      {
        n: 1,
        lhsArgs: [slot(0)],
        body: {
          tag: "seq",
          goals: [],
          tail: { tag: "call", fn: "loop", args: [slot(0)] },
        },
      },
    ];
    const jit = compileJitGroup(new Map([["loop", loop]]), new Map([["loop", 1]]), BAIL)!;

    expect(thrownBy(() => run(jit, "loop", [gint(1)], 1))).toBe(BAIL);
  });

  it("declines a group with a wrong-arity tail call", () => {
    const leaf: SkelClause[] = [
      {
        n: 1,
        lhsArgs: [node(constant("C"), slot(0))],
        body: template(node(constant("Box"), slot(0))),
      },
    ];
    const root: SkelClause[] = [
      {
        n: 0,
        lhsArgs: [],
        body: { tag: "seq", goals: [], tail: { tag: "call", fn: "leaf", args: [] } },
      },
    ];

    expect(
      compileJitGroup(
        new Map([
          ["leaf", leaf],
          ["root", root],
        ]),
        new Map([
          ["leaf", 1],
          ["root", 0],
        ]),
        BAIL,
      ),
    ).toBeUndefined();
  });

  it("accepts matching and variable inputs through a shared constructor shell", () => {
    const clauses: SkelClause[] = [
      {
        n: 1,
        lhsArgs: [node(constant("Pair"), constant("left"), slot(0))],
        body: template(node(constant("Out"), constant("left"), slot(0))),
      },
      {
        n: 1,
        lhsArgs: [node(constant("Pair"), constant("right"), slot(0))],
        body: template(node(constant("Out"), constant("right"), slot(0))),
      },
    ];
    const jit = compileJitGroup(new Map([["pick", clauses]]), new Map([["pick", 1]]), BAIL)!;

    expect(run(jit, "pick", [expr([sym("Pair"), sym("left"), sym("payload")])])).toEqual([
      "(Out left payload)",
    ]);
    expect(run(jit, "pick", [variable("whole")])).toEqual([
      "(Out left $_c#0)",
      "(Out right $_c#0)",
    ]);
    expect(
      thrownBy(() => run(jit, "pick", [expr([sym("Other"), sym("left"), sym("payload")])])),
    ).toBe(BAIL);
  });

  it("uses a shared constructor shell for internal tail calls", () => {
    const pick: SkelClause[] = [
      {
        n: 1,
        lhsArgs: [node(constant("Wrap"), constant("left"), slot(0))],
        body: template(node(constant("Hit"), constant("left"), slot(0))),
      },
      {
        n: 1,
        lhsArgs: [node(constant("Wrap"), constant("right"), slot(0))],
        body: template(node(constant("Hit"), constant("right"), slot(0))),
      },
    ];
    const exact: SkelClause[] = [
      {
        n: 0,
        lhsArgs: [],
        body: {
          tag: "seq",
          goals: [],
          tail: {
            tag: "call",
            fn: "pick",
            args: [node(constant("Wrap"), constant("right"), constant("payload"))],
          },
        },
      },
    ];
    const bad: SkelClause[] = [
      {
        n: 0,
        lhsArgs: [],
        body: {
          tag: "seq",
          goals: [],
          tail: {
            tag: "call",
            fn: "pick",
            args: [node(constant("Other"), constant("right"), constant("payload"))],
          },
        },
      },
    ];
    const jit = compileJitGroup(
      new Map([
        ["pick", pick],
        ["exact", exact],
        ["bad", bad],
      ]),
      new Map([
        ["pick", 1],
        ["exact", 0],
        ["bad", 0],
      ]),
      BAIL,
    )!;

    expect(run(jit, "exact", [])).toEqual(["(Hit right payload)"]);
    expect(thrownBy(() => run(jit, "bad", []))).toBe(BAIL);
  });

  it("restores first-use result aliases between callback alternatives", () => {
    const source: SkelClause[] = [
      {
        n: 0,
        lhsArgs: [],
        body: template(node(constant("Pair"), constant("a"), constant("a"))),
      },
      {
        n: 0,
        lhsArgs: [],
        body: template(node(constant("Pair"), constant("a"), constant("b"))),
      },
    ];
    const same: SkelClause[] = [
      {
        n: 1,
        lhsArgs: [],
        body: callThen(
          node(constant("Pair"), slot(0), slot(0)),
          [],
          node(constant("Same"), slot(0)),
        ),
      },
    ];
    const jit = compileJitGroup(
      new Map([
        ["source", source],
        ["same", same],
      ]),
      new Map([
        ["source", 0],
        ["same", 0],
      ]),
      BAIL,
    )!;

    expect(run(jit, "same", [])).toEqual(["(Same a)"]);
    expect(run(jit, "same", [])).toEqual(["(Same a)"]);
  });

  it("clears a first-use result alias before a later variable answer", () => {
    const source: SkelClause[] = [
      { n: 0, lhsArgs: [], body: template(node(constant("Pair"), constant("a"))) },
      { n: 1, lhsArgs: [], body: template(slot(0)) },
    ];
    const probe: SkelClause[] = [
      {
        n: 1,
        lhsArgs: [],
        body: callThen(node(constant("Pair"), slot(0)), [], node(constant("Seen"), slot(0))),
      },
    ];
    const jit = compileSourceProbe(source, probe, 0);

    expect(run(jit, "probe", [])).toEqual(["(Seen a)", "(Seen $_c#0)"]);
  });

  it("keeps the occurs check when a result pattern slot was introduced by the call", () => {
    const source: SkelClause[] = [
      {
        n: 1,
        lhsArgs: [slot(0)],
        body: template(node(constant("Wrap"), slot(0))),
      },
    ];
    const probe: SkelClause[] = [
      {
        n: 1,
        lhsArgs: [],
        body: callThen(slot(0), [slot(0)], constant("accepted")),
      },
    ];
    const jit = compileSourceProbe(source, probe, 1);

    expect(run(jit, "probe", [])).toEqual([]);
  });

  it("keeps the occurs check when a structured write contains a call-introduced slot", () => {
    const source: SkelClause[] = [
      {
        n: 1,
        lhsArgs: [slot(0)],
        body: template(slot(0)),
      },
    ];
    const probe: SkelClause[] = [
      {
        n: 1,
        lhsArgs: [],
        body: callThen(node(constant("Wrap"), slot(0)), [slot(0)], constant("accepted")),
      },
    ];
    const jit = compileSourceProbe(source, probe, 1);

    expect(run(jit, "probe", [])).toEqual([]);
  });

  it("binds a fresh structured result while preserving repeated-variable identity", () => {
    const source: SkelClause[] = [
      {
        n: 1,
        lhsArgs: [],
        body: template(slot(0)),
      },
    ];
    const probe: SkelClause[] = [
      {
        n: 1,
        lhsArgs: [],
        body: callThen(
          node(constant("Pair"), slot(0), slot(0)),
          [],
          node(constant("Seen"), slot(0), slot(0)),
        ),
      },
    ];
    const jit = compileSourceProbe(source, probe, 0);

    expect(run(jit, "probe", [])).toEqual(["(Seen $_c#0 $_c#0)"]);
  });

  it("keeps distinct first-use fields separate across every answer", () => {
    const source: SkelClause[] = [
      {
        n: 0,
        lhsArgs: [],
        body: template(node(constant("Pair"), constant("a"), constant("c"))),
      },
      {
        n: 0,
        lhsArgs: [],
        body: template(node(constant("Pair"), constant("b"), constant("d"))),
      },
    ];
    const copy: SkelClause[] = [
      {
        n: 2,
        lhsArgs: [],
        body: {
          tag: "seq",
          goals: [
            {
              pat: node(constant("Pair"), slot(0), slot(1)),
              fn: "source",
              args: [],
            },
          ],
          tail: { tag: "tpl", tpl: node(constant("Copy"), slot(0), slot(1)) },
        },
      },
    ];
    const jit = compileJitGroup(
      new Map([
        ["source", source],
        ["copy", copy],
      ]),
      new Map([
        ["source", 0],
        ["copy", 0],
      ]),
      BAIL,
    )!;

    expect(run(jit, "copy", [])).toEqual(["(Copy a c)", "(Copy b d)"]);
  });

  it("keeps a result check when any callee branch changes that field", () => {
    const maybe: SkelClause[] = [
      {
        n: 1,
        lhsArgs: [node(constant("Pair"), constant("keep"), slot(0))],
        body: template(node(constant("Box"), constant("keep"), slot(0))),
      },
      {
        n: 1,
        lhsArgs: [node(constant("Pair"), constant("change"), slot(0))],
        body: template(node(constant("Box"), constant("changed"), slot(0))),
      },
    ];
    const check: SkelClause[] = [
      {
        n: 1,
        lhsArgs: [],
        body: {
          tag: "seq",
          goals: [
            {
              pat: node(constant("Box"), constant("change"), slot(0)),
              fn: "maybe",
              args: [node(constant("Pair"), constant("change"), constant("payload"))],
            },
          ],
          tail: { tag: "tpl", tpl: node(constant("Box"), constant("accepted"), slot(0)) },
        },
      },
    ];
    const jit = compileJitGroup(
      new Map([
        ["maybe", maybe],
        ["check", check],
      ]),
      new Map([
        ["maybe", 1],
        ["check", 0],
      ]),
      BAIL,
    )!;

    expect(run(jit, "check", [])).toEqual([]);
  });

  it("propagates and rejects conflicting projections through tail calls", () => {
    const leaf: SkelClause[] = [
      {
        n: 1,
        lhsArgs: [slot(0)],
        body: template(node(constant("Out"), slot(0))),
      },
    ];
    const relay: SkelClause[] = [
      {
        n: 2,
        lhsArgs: [node(constant("In"), slot(0), slot(1))],
        body: {
          tag: "seq",
          goals: [],
          tail: { tag: "call", fn: "leaf", args: [slot(0)] },
        },
      },
      {
        n: 2,
        lhsArgs: [node(constant("In"), slot(0), slot(1))],
        body: {
          tag: "seq",
          goals: [],
          tail: { tag: "call", fn: "leaf", args: [slot(1)] },
        },
      },
    ];
    const probe: SkelClause[] = [
      {
        n: 0,
        lhsArgs: [],
        body: {
          tag: "seq",
          goals: [
            {
              pat: node(constant("Out"), constant("a")),
              fn: "relay",
              args: [node(constant("In"), constant("a"), constant("b"))],
            },
          ],
          tail: { tag: "tpl", tpl: node(constant("Out"), constant("accepted")) },
        },
      },
    ];
    const jit = compileJitGroup(
      new Map([
        ["leaf", leaf],
        ["relay", relay],
        ["probe", probe],
      ]),
      new Map([
        ["leaf", 1],
        ["relay", 1],
        ["probe", 0],
      ]),
      BAIL,
    )!;

    expect(run(jit, "probe", [])).toEqual(["(Out accepted)"]);
  });

  it("does not equate an evaluated call argument with the same structural result pattern", () => {
    const identity: SkelClause[] = [
      {
        n: 1,
        lhsArgs: [slot(0)],
        body: template(node(constant("Box"), slot(0))),
      },
    ];
    const arithmetic = add(integer(1), integer(2));
    const check: SkelClause[] = [
      {
        n: 0,
        lhsArgs: [],
        body: {
          tag: "seq",
          goals: [
            {
              pat: node(constant("Box"), arithmetic),
              fn: "identity",
              args: [arithmetic],
            },
          ],
          tail: { tag: "tpl", tpl: node(constant("Box"), constant("accepted")) },
        },
      },
    ];
    const jit = compileJitGroup(
      new Map([
        ["identity", identity],
        ["check", check],
      ]),
      new Map([
        ["identity", 1],
        ["check", 0],
      ]),
      BAIL,
    )!;

    expect(run(jit, "identity", [gint(3)])).toEqual(["(Box 3)"]);
    expect(run(jit, "check", [])).toEqual([]);
  });

  it("does not reuse a matched subtree whose body instantiation folds arithmetic", () => {
    const left = node(constant("Left"), add(integer(1), integer(2)));
    const right = node(constant("Right"), constant("extra"), add(integer(2), integer(3)));
    const clauses: SkelClause[] = [
      { n: 0, lhsArgs: [left], body: template(node(constant("Box"), left)) },
      { n: 0, lhsArgs: [right], body: template(node(constant("Box"), right)) },
    ];
    const jit = compileJitGroup(new Map([["fold", clauses]]), new Map([["fold", 1]]), BAIL)!;

    expect(run(jit, "fold", [expr([sym("Left"), expr([sym("+"), gint(1), gint(2)])])])).toEqual([
      "(Box (Left 3))",
    ]);
    expect(
      run(jit, "fold", [expr([sym("Right"), sym("extra"), expr([sym("+"), gint(2), gint(3)])])]),
    ).toEqual(["(Box (Right extra 5))"]);
  });
});
