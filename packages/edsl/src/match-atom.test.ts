// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Taking a result apart. The claim is that the handler's argument is typed from the pattern, so the
// compile-time assertions matter as much as the runtime ones.
import { describe, expect, it } from "vitest";
import {
  Match,
  NonExhaustiveError,
  P,
  ground,
  isMatching,
  matchAtom,
  matchBindings,
  mettaDB,
  names,
  vars,
} from "./index";

type Exact<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const exact = <T extends true>(): T | undefined => undefined;
/** Asserts the static type of a value at the point of use, and hands it straight back. */
const exactly = <T>(v: T): T => v;

const { Likes, Age, Hot, Ada } = names("Likes", "Age", "Hot", "Ada");

describe("matching an atom", () => {
  it("binds what the pattern names, typed", () => {
    const atom = ground([Likes, "Ada", "Coffee"]);
    const out = matchAtom(atom)
      .with([Likes, P.str("who"), P.str("drink")], (b) => {
        exact<Exact<typeof b, { who: string; drink: string }>>();
        return `${b.who} likes ${b.drink}`;
      })
      .otherwise(() => "no");
    expect(out).toBe("Ada likes Coffee");
  });

  it("tries arms in order and takes the first that fits", () => {
    const describeAtom = (a: unknown): string =>
      matchAtom(a as never)
        .with([Likes, P.str("who"), P.str("drink")], ({ who, drink }) => `${who} likes ${drink}`)
        .with([Age, P.str("who"), P.num("years")], ({ who, years }) => `${who} is ${years}`)
        .otherwise((atom) => `unknown: ${String(atom)}`);

    expect(describeAtom(ground([Likes, "Ada", "Coffee"]))).toBe("Ada likes Coffee");
    expect(describeAtom(ground([Age, "Ada", 36]))).toBe("Ada is 36");
    expect(describeAtom(ground([Hot, 1]))).toBe("unknown: (Hot 1)");
  });

  it("keeps a symbol and a grounded string apart, which is the point of matching ATOMS", () => {
    // `atomToJs` makes both a JavaScript string, so matching the unwrapped value could not tell them
    // apart — and that difference is the commonest MeTTa bug there is.
    const symbolHeaded = ground([Likes, Ada, "x"]);
    const stringHeaded = ground([Likes, "Ada", "x"]);
    const which = (a: unknown): string =>
      matchAtom(a as never)
        .with([Likes, P.sym("who"), P._], ({ who }) => `symbol ${who}`)
        .with([Likes, P.str("who"), P._], ({ who }) => `string ${who}`)
        .otherwise(() => "neither");
    expect(which(symbolHeaded)).toBe("symbol Ada");
    expect(which(stringHeaded)).toBe("string Ada");
  });

  it("matches nested patterns, gathering bindings from every depth", () => {
    const atom = ground([Likes, "Ada", [Hot, "dark"]]);
    const out = matchAtom(atom)
      .with([Likes, P.str("who"), [P.sym("kind"), P.str("roast")]], (b) => {
        exact<Exact<typeof b, { who: string; kind: string; roast: string }>>();
        return `${b.who}: ${b.kind}/${b.roast}`;
      })
      .run();
    expect(out).toBe("Ada: Hot/dark");
  });

  it("takes the remaining arguments with rest", () => {
    expect(
      matchAtom(ground([Likes, 1, 2, 3]))
        .with([Likes, P.rest("args")], ({ args }) => args)
        .run(),
    ).toEqual([1, 2, 3]);
  });

  it("matches a variable, since an unreduced answer still holds one", () => {
    const { x } = vars("x");
    expect(
      matchAtom(ground([Likes, x]))
        .with([Likes, P.var("v")], ({ v }) => v)
        .run(),
    ).toBe("x");
    // and a variable is not a symbol
    expect(
      matchAtom(ground([Likes, x]))
        .with([Likes, P.sym("s")], ({ s }) => s)
        .run(),
    ).toBeUndefined();
  });

  it("requires the arity to agree", () => {
    expect(
      matchAtom(ground([Likes, "a"]))
        .with([Likes, P._, P._], () => "two")
        .run(),
    ).toBeUndefined();
    expect(
      matchAtom(ground([Likes, "a", "b"]))
        .with([Likes, P._, P._], () => "two")
        .run(),
    ).toBe("two");
  });

  it("compares a literal by the atom it grounds to", () => {
    expect(
      matchAtom(ground([Likes, "Ada", 36]))
        .with([Likes, "Ada", P.num("n")], ({ n }) => n)
        .run(),
    ).toBe(36);
    expect(
      matchAtom(ground([Likes, "Bob", 36]))
        .with([Likes, "Ada", P.num("n")], ({ n }) => n)
        .run(),
    ).toBeUndefined();
  });

  it("answers undefined from run and the fallback from otherwise", () => {
    const atom = ground([Hot, 1]);
    expect(
      matchAtom(atom)
        .with([Likes, P._], () => 1)
        .run(),
    ).toBeUndefined();
    expect(
      matchAtom(atom)
        .with([Likes, P._], () => 1)
        .otherwise(() => "fell through"),
    ).toBe("fell through");
  });

  it("guards a value with a predicate the shape checks cannot express", () => {
    const grown = (a: unknown): string =>
      matchAtom(a as never)
        .with([Age, P.str("who"), P.when((n: number) => n >= 18, "years")], ({ who, years }) =>
          exactly<number>(years) === years ? `${who} adult ${years}` : "",
        )
        .with([Age, P.str("who"), P.num("years")], ({ who, years }) => `${who} minor ${years}`)
        .otherwise(() => "?");
    expect(grown(ground([Age, "Ada", 36]))).toBe("Ada adult 36");
    expect(grown(ground([Age, "Kid", 9]))).toBe("Kid minor 9");
  });

  it("takes any of several alternatives in one position", () => {
    const val = (a: unknown): unknown =>
      matchAtom(a as never)
        .with([Hot, P.union([P.str(), P.num()], "v")], ({ v }) => v)
        .run();
    expect(val(ground([Hot, "warm"]))).toBe("warm");
    expect(val(ground([Hot, 40]))).toBe(40);
    expect(val(ground([Hot, true]))).toBeUndefined();
  });

  it("refuses what a pattern accepts", () => {
    const notText = (a: unknown): unknown =>
      matchAtom(a as never)
        .with([Hot, P.not(P.str(), "v")], ({ v }) => v)
        .run();
    expect(notText(ground([Hot, 40]))).toBe(40);
    expect(notText(ground([Hot, "warm"]))).toBeUndefined();
  });

  it("tries several whole patterns against one handler", () => {
    const who = (a: unknown): unknown =>
      matchAtom(a as never)
        .withAny(
          [
            [Likes, P.str("name"), P._],
            [Age, P.str("name"), P._],
          ],
          (b) => b.name,
        )
        .run();
    expect(who(ground([Likes, "Ada", "Coffee"]))).toBe("Ada");
    expect(who(ground([Age, "Turing", 41]))).toBe("Turing");
    expect(who(ground([Hot, 1]))).toBeUndefined();
  });

  it("answers whether a pattern fits, for filtering rather than branching", () => {
    const atoms = [ground([Likes, "Ada", "Coffee"]), ground([Age, "Ada", 36])];
    expect(atoms.filter((a) => isMatching([Likes, P._, P._], a))).toHaveLength(1);
    expect(matchBindings([Likes, P.str("who"), P._], atoms[0]!)).toEqual({ who: "Ada" });
    expect(matchBindings([Likes, P.str("who"), P._], atoms[1]!)).toBeUndefined();
  });

  it("reads evaluation results, which is what it is for", () => {
    const db = mettaDB();
    const { pair } = names("pair");
    db.add([pair, "a", 1], [pair, "b", 2]);
    const { k, v } = vars("k", "v");
    const rows = db.eval(Match([pair, k, v], [pair, k, v])).map((a) =>
      matchAtom(a)
        .with([pair, P.str("key"), P.num("val")], ({ key, val }) => `${key}=${val}`)
        .otherwise(() => "?"),
    );
    expect(rows.sort()).toEqual(["a=1", "b=2"]);
  });
});

describe("matching every head the schema declares", () => {
  const db = mettaDB<{
    relations: { Likes: [string, string]; Age: [string, number] };
  }>();
  db.add([Likes, "Ada", "Coffee"], [Age, "Ada", 36]);
  const [likes, age] = db.space.atoms();

  it("compiles once every declared head has an arm", () => {
    const describeAtom = (a: typeof likes): string =>
      db
        .match(a!)
        .with([Likes, P.str("who"), P.str("drink")], ({ who, drink }) => `${who} likes ${drink}`)
        .with([Age, P.str("who"), P.num("years")], ({ who, years }) => `${who} is ${years}`)
        .exhaustive();
    expect(describeAtom(likes)).toBe("Ada likes Coffee");
    expect(describeAtom(age)).toBe("Ada is 36");
  });

  it("does not compile with a head left out, and names which one", () => {
    // The type of `.exhaustive` is `NonExhaustive<"Age">`, which has no call signature — ts-pattern's
    // trick, over the heads a schema declares rather than over a discriminated union.
    db.match(likes!)
      .with([Likes, P.str("who"), P.str("drink")], ({ who, drink }) => `${who}${drink}`)
      // @ts-expect-error the Age arm is missing
      .exhaustive();
  });

  it("says so when there is no schema to check against", () => {
    mettaDB()
      .match(likes!)
      .with([Likes, P._, P._], () => 1)
      // @ts-expect-error no declared heads, so there is nothing to be exhaustive over
      .exhaustive();
  });

  it("counts a withAny arm as covering every head it names", () => {
    const out = db
      .match(age!)
      .withAny(
        [
          [Likes, P.str("who"), P._],
          [Age, P.str("who"), P._],
        ],
        ({ who }) => who,
      )
      .exhaustive();
    expect(out).toBe("Ada");
  });

  it("throws when an atom from outside the declaration reaches it", () => {
    // Exhaustiveness is over what the schema DECLARES, and an atom can still arrive from `run`, an
    // import, or a decoded payload. No static check rules that out, so the runtime says so.
    const stranger = db.eval(["Hot", 1])[0]!;
    expect(() =>
      db
        .match(stranger)
        .with([Likes, P._, P._], () => "l")
        .with([Age, P._, P._], () => "a")
        .exhaustive(),
    ).toThrow(NonExhaustiveError);
  });

  it("fixes the result type of every arm with returnType", () => {
    const out = db
      .match(likes!)
      .returnType<string>()
      .with([Likes, P.str("who"), P._], ({ who }) => who)
      .with([Age, P.str("who"), P._], ({ who }) => who)
      .exhaustive();
    exact<Exact<typeof out, string>>();
    expect(out).toBe("Ada");
  });
});
