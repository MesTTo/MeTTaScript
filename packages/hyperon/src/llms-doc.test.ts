// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// The claims in this package's LLMS.md, run. That document is written to be read by a language model
// which then generates code against this API, so a stale example there is copied verbatim rather than
// merely misread.
import { describe, expect, it } from "vitest";
import { S, V, E, ValueAtom, GroundingSpace, MeTTa, atomToJs, type GroundedAtom } from "./index.js";

describe("hyperon/LLMS.md claims", () => {
  it("prints the atom constructors as documented", () => {
    expect([String(S("parent")), String(V("x")), String(E(S("parent"), S("tom"), V("c")))]).toEqual(
      ["parent", "$x", "(parent tom $c)"],
    );
    expect([String(ValueAtom(42)), String(ValueAtom("hi"))]).toEqual(["42", '"hi"']);
  });

  it("resolves a match through BindingsSet frames", () => {
    const set = E(S("point"), V("x"), V("y")).matchAtom(E(S("point"), ValueAtom(1), ValueAtom(2)));
    expect([
      set.frames[0]!.resolve(V("x"))?.toString(),
      set.frames[0]!.resolve(V("y"))?.toString(),
    ]).toEqual(["1", "2"]);
  });

  it("substitutes over a GroundingSpace", () => {
    const sp = new GroundingSpace();
    sp.addAtom(E(S("parent"), S("tom"), S("bob")));
    sp.addAtom(E(S("parent"), S("tom"), S("liz")));
    expect(sp.subst(E(S("parent"), S("tom"), V("c")), V("c")).map(String)).toEqual(["bob", "liz"]);
  });

  it("keeps runner state across run calls, returning Atom[][]", () => {
    const m = new MeTTa();
    m.run("(= (color) red)\n(= (color) green)");
    expect(m.run("!(color)")[0]!.map(String)).toEqual(["red", "green"]);
    const nested = m.run("!(+ 1 2)");
    expect([Array.isArray(nested), Array.isArray(nested[0])]).toEqual([true, true]);
  });

  it("calls TypeScript from MeTTa through a registered operation", () => {
    const m = new MeTTa();
    m.registerOperation("double", (args) => [
      ValueAtom(((args[0] as GroundedAtom).object().content as number) * 2),
    ]);
    expect(m.run("!(double 21)")[0]!.map(String)).toEqual(["42"]);
  });

  it("unwraps atoms with atomToJs, and keeps ValueAtom distinct from S", () => {
    expect([atomToJs(ValueAtom(42)), atomToJs(S("hi"))]).toEqual([42, "hi"]);
    expect(String(ValueAtom("hi")) === String(S("hi"))).toBe(false);
  });

  it("leaves stored data unreduced when evaluated as a call", () => {
    const m = new MeTTa();
    m.run("(Likes Ada Coffee)");
    expect(m.run("!(Likes Ada $x)")[0]!.map(String)).toEqual(["(Likes Ada $x)"]);
  });
});
