// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// MeTTa reports failure as a value, so a failed evaluation arrives looking like a successful one. These
// check both halves: the default stays MeTTa's semantics, and the raising forms actually raise.
import { describe, expect, it } from "vitest";
import {
  M,
  MettaError,
  errorAtoms,
  errorParts,
  errorText,
  isErrorAtom,
  mettaDB,
  mul,
  names,
  Try,
  Catch,
  IfError,
  ErrorAtom,
} from "./index";

describe("seeing a MeTTa error", () => {
  it("leaves an error in the results by default, because that is what MeTTa does", () => {
    // The point of the helpers is that this is easy to MISS: one result, no exception, and mapping it
    // to JS gives a nested array that reads like data.
    const db = mettaDB();
    const results = db.eval(mul("not-a-number", 2));
    expect(results).toHaveLength(1);
    expect(String(results[0])).toBe('(Error (* "not-a-number" 2) (BadArgType 1 Number String))');
    expect(db.evalJs(mul("not-a-number", 2))[0]).toEqual([
      "Error",
      ["*", "not-a-number", 2],
      ["BadArgType", 1, "Number", "String"],
    ]);
  });

  it("recognises one, and reads its two parts", () => {
    const db = mettaDB();
    const [bad] = db.eval(mul("not-a-number", 2));
    expect(isErrorAtom(bad!)).toBe(true);
    expect(errorParts(bad!)).toEqual({
      subject: '(* "not-a-number" 2)',
      description: "(BadArgType 1 Number String)",
    });
    expect(errorText(bad!)).toBe('(BadArgType 1 Number String) in (* "not-a-number" 2)');

    const [good] = db.eval(mul(6, 7));
    expect(isErrorAtom(good!)).toBe(false);
    expect(errorText(good!)).toBeUndefined();
    expect(errorAtoms(db.eval(mul(6, 7)))).toEqual([]);
  });

  it("raises on request, carrying the error atoms", () => {
    const db = mettaDB();
    expect(() => db.evalJsOrThrow(mul("not-a-number", 2))).toThrow(MettaError);
    try {
      db.evalOrThrow(mul("not-a-number", 2));
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(MettaError);
      const err = e as MettaError;
      expect(err.message).toContain("BadArgType");
      // the atoms come with it, so MeTTa's own error handling is still open to the caller
      expect(err.errors).toHaveLength(1);
      expect(isErrorAtom(err.errors[0]!)).toBe(true);
    }
  });

  it("passes a successful evaluation straight through", () => {
    const db = mettaDB();
    expect(db.evalJsOrThrow(mul(6, 7))).toEqual([42]);
    expect(db.evalOrThrow(mul(6, 7)).map(String)).toEqual(["42"]);
  });

  it("collects every error when a nondeterministic branch produces several", () => {
    const db = mettaDB();
    const { superpose } = names("superpose");
    try {
      db.evalOrThrow(superpose([mul("a", 1), mul("b", 2)]));
      expect.unreachable("should have thrown");
    } catch (e) {
      const err = e as MettaError;
      expect(err.errors).toHaveLength(2);
      expect(err.message).toContain("2 errors");
    }
  });

  it("raises from a chain too", () => {
    const db = mettaDB();
    expect(
      M([1, 2])
        .map((x: number) => x * 10)
        .jsOrThrow(db),
    ).toEqual([[10, 20]]);
    // The chain's fallback dispatches to a MeTTa NAME, not to an eDSL builder name: `*`, not `mul`.
    // `(mul ...)` would just be an unknown head, which does not reduce and is not an error.
    expect(() => M("not-a-number")["*"](2).jsOrThrow(db)).toThrow(MettaError);
    expect(M(6)["*"](7).js(db)).toEqual([42]);
  });

  it("catches an error with Try, and passes a value straight through", () => {
    // `if-error` alone cannot do this: it takes an `Atom` parameter, so it inspects its argument
    // UNEVALUATED. `(if-error (boom) caught ok)` answers `ok`, because the literal expression `(boom)`
    // is not an error atom and is never run. `Try` chains an `eval` in front, which is the difference.
    const db = mettaDB();
    const { boom, ok, CAUGHT } = names("boom", "ok", "CAUGHT");
    db.rule(boom(), ErrorAtom("boom-called", "it broke"));
    db.rule(ok(), 42);

    expect(db.evalJs(Try(boom(), (e) => CAUGHT(e)))).toEqual([
      ["CAUGHT", ["Error", "boom-called", "it broke"]],
    ]);
    expect(db.evalJs(Try(ok(), (e) => CAUGHT(e)))).toEqual([42]);
    expect(db.evalJs(Catch(boom(), "RECOVERED"))).toEqual(["RECOVERED"]);
    expect(db.evalJs(Catch(ok(), "RECOVERED"))).toEqual([42]);

    // the bare form really does answer wrongly, which is why Try exists
    expect(db.evalJs(IfError(boom(), "CAUGHT", "not-an-error"))).toEqual(["not-an-error"]);
  });

  it("catches a TypeScript exception thrown inside MeTTa", () => {
    // A `db.fn` body that throws already arrives as an `(Error ...)`, so `Try` catches it and
    // `evalOrThrow` turns it back into a TypeScript exception. The round trip closes.
    const db = mettaDB();
    db.fn("tsboom", () => {
      throw new Error("from TypeScript");
    });
    const { tsboom } = names("tsboom");

    // the JS message arrives as a symbol, not a grounded string
    expect(db.eval(tsboom(1)).map(String)).toEqual(["(Error (tsboom 1) from TypeScript)"]);
    expect(db.evalJs(Catch(tsboom(1), "CAUGHT-TS"))).toEqual(["CAUGHT-TS"]);
    expect(() => db.evalOrThrow(tsboom(1))).toThrow(MettaError);
  });

  it("does not mistake an unreduced expression for an error", () => {
    // An unknown head is not a failure in MeTTa, it is just data that did not reduce. Raising on it
    // would make the strict forms unusable for ordinary symbolic work.
    const db = mettaDB();
    const { unknownHead } = names("unknownHead");
    expect(() => db.evalOrThrow(unknownHead(1))).not.toThrow();
    expect(db.eval(unknownHead(1)).map(String)).toEqual(["(unknownHead 1)"]);
  });
});
