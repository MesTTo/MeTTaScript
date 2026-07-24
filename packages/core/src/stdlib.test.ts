// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

import { describe, it, expect, afterEach } from "vitest";
import { runProgram } from "./runner";
import { format } from "./parser";
import { setOutputSink, setRawSink } from "./builtins";

// The hardcoded MeTTa standard library (always loaded). Host primitives (println!/format-args) are
// grounded; the rest is MeTTa. TS-native extensions (transaction/concurrency) are NOT here.
const r1 = (src: string): string[] => {
  const rs = runProgram(src);
  return rs[rs.length - 1]!.results.map(format);
};

let restore: ((line: string) => void) | undefined;
const capture = (): string[] => {
  const lines: string[] = [];
  restore = setOutputSink((l) => lines.push(l));
  return lines;
};
afterEach(() => {
  if (restore) setOutputSink(restore);
  restore = undefined;
});

describe("stdlib IO", () => {
  it("println! prints (unquoting strings) and returns unit", () => {
    const lines = capture();
    expect(r1(`!(println! "hello")`)).toEqual(["()"]);
    expect(r1(`!(println! (a b 1))`)).toEqual(["()"]);
    expect(lines).toEqual(["hello", "(a b 1)"]);
  });

  it("print! writes raw with no trailing newline (unlike println!)", () => {
    const chunks: string[] = [];
    const restoreRaw = setRawSink((t) => chunks.push(t));
    try {
      expect(r1(`!(print! a)`)).toEqual(["()"]);
      expect(r1(`!(print! "hi")`)).toEqual(["()"]);
      // each print! emits exactly its text, no newline appended (println! is the line variant)
      expect(chunks).toEqual(["a", "hi"]);
    } finally {
      setRawSink(restoreRaw);
    }
  });

  it("format-args fills {} placeholders", () => {
    expect(r1(`!(format-args "x={} y={}" (5 foo))`)).toEqual([`"x=5 y=foo"`]);
  });

  it("trace! prints its first argument and returns the evaluated second", () => {
    const lines = capture();
    expect(r1(`!(trace! "dbg" (+ 1 2))`)).toEqual(["3"]);
    expect(lines).toEqual(["dbg"]);
  });

  it("repr renders an atom as a String", () => {
    expect(r1(`!(repr (a b))`)).toEqual([`"(a b)"`]);
  });
});

describe("stdlib module functions", () => {
  it("module-space-no-deps is identity in @metta-ts", () => {
    expect(r1(`!(module-space-no-deps &self)`)).toEqual(["&self"]);
  });
  it("mod-space! loads a module into a fresh space", () => {
    expect(r1(`!(get-type (mod-space! concurrency))`)).toEqual(["SpaceType"]);
  });
  it("git-module! is an explicit unsupported error", () => {
    const out = r1(`!(git-module! "http://x")`);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("not supported");
  });
});

describe("stdlib doc machinery", () => {
  it("undefined-doc-function-type produces one %Undefined% per param plus return", () => {
    expect(r1(`!(undefined-doc-function-type (a b))`)).toEqual([
      "(%Undefined% %Undefined% %Undefined%)",
    ]);
  });
});

describe("stdlib include", () => {
  it("include imports a module into &self", () => {
    // importing the concurrency module makes `transaction` reachable
    expect(r1(`!(include concurrency) !(transaction (add-atom &self (x 1)))`)).toBeDefined();
  });
});

describe("spaces: get-atoms follows LeaTTa add-atom semantics", () => {
  // LeaTTa evaluates `add-atom` arguments before storage, so get-atoms returns the reduced atom.
  it("returns a stored atom after add-atom argument evaluation", () => {
    expect(
      r1("!(bind! &g (new-space)) !(add-atom &g (color (+ 2 3) red)) !(get-atoms &g)"),
    ).toEqual(["(color 5 red)"]);
  });

  it("add-atom itself already stores the argument unevaluated", () => {
    expect(
      r1("!(bind! &h (new-space)) !(add-atom &h (foo (+ 1 1))) !(match &h $x (quote $x))"),
    ).toEqual(["(quote (foo (+ 1 1)))"]);
  });
});

describe("stdlib stringToChars / charsToString", () => {
  it("stringToChars splits a string into single-character symbols", () => {
    expect(r1('!(stringToChars "abc")')).toEqual(["(a b c)"]);
  });

  it("stringToChars of the empty string is the empty expression", () => {
    expect(r1('!(stringToChars "")')).toEqual(["()"]);
  });

  it("charsToString joins a character list into a string", () => {
    expect(r1("!(charsToString (a b c))")).toEqual(['"abc"']);
  });

  it("round-trips a string through its characters", () => {
    // charsToString takes an Expression argument (unevaluated, like car-atom and hyperon-experimental), so
    // a decoder binds the character list with let, or walks it with list ops, rather than nesting directly.
    expect(r1('!(let $cs (stringToChars "e1_ep") (charsToString $cs))')).toEqual(['"e1_ep"']);
  });

  it("decomposes a legacy typed-symbol name into its characters", () => {
    expect(r1('!(stringToChars "e1_ep")')).toEqual(["(e 1 _ e p)"]);
  });

  it("round-trips a string whose characters are operator symbols", () => {
    // This is why charsToString takes Expression rather than %Undefined%: the character list of "+ab" is
    // `(+ a b)`, so evaluating the argument would run it as an addition instead of joining it back.
    expect(r1('!(stringToChars "+ab")')).toEqual(["(+ a b)"]);
    expect(r1('!(let $cs (stringToChars "+ab") (charsToString $cs))')).toEqual(['"+ab"']);
  });

  it("keeps an astral character whole rather than splitting its surrogate pair", () => {
    expect(r1('!(stringToChars "a\u{1F600}b")')).toEqual(["(a \u{1F600} b)"]);
  });

  it("evaluates the argument of stringToChars, so it composes with String-producing calls", () => {
    expect(r1("!(stringToChars (repr foo))")).toEqual(["(f o o)"]);
  });
});
