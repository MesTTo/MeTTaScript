// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

import { describe, it, expect } from "vitest";
import { parse, parseAll, format } from "./parser";
import { Tokenizer } from "./tokenizer";
import { gint, gfloat, atomEq } from "./atom";

const tk = (): Tokenizer => {
  const t = new Tokenizer();
  t.register(/^-?\d+$/, (s) => gint(Number(s)));
  t.register(/^-?\d+\.\d+$/, (s) => gfloat(Number(s)));
  return t;
};

describe("parser", () => {
  it("parses and round-trips a function definition", () => {
    expect(format(parse("(= (f $x) (+ $x 1))", tk())!)).toBe("(= (f $x) (+ $x 1))");
  });

  it("treats a non-tokenized word as a Symbol", () => {
    expect(format(parse("foo", tk())!)).toBe("foo");
  });

  it("parses strings as grounded String atoms and round-trips quotes", () => {
    expect(format(parse('"hi there"', tk())!)).toBe('"hi there"');
  });

  it("skips comments and reads a program atom-by-atom, tracking the bang flag", () => {
    const atoms = parseAll("; a comment\n(a b)\n!(+ 1 2)", tk());
    expect(atoms.length).toBe(2);
    expect(atoms[0]!.bang).toBe(false);
    expect(atoms[1]!.bang).toBe(true);
  });

  it("keeps semicolons inside variable tokens", () => {
    expect(format(parse("$foo;bar", tk())!)).toBe("$foo;bar");
  });

  it("still treats semicolons after word tokens as comments", () => {
    const atoms = parseAll("foo;bar\nbaz", tk()).map((top) => format(top.atom));
    expect(atoms).toEqual(["foo", "baz"]);
  });

  it("keeps quotes inside word tokens after the first character", () => {
    expect(format(parse('foo"bar"', tk())!)).toBe('foo"bar"');
  });

  it("does not split a top-level bang-prefixed quoted word into a query", () => {
    const [top] = parseAll('!foo"bar"', tk());
    expect(top!.bang).toBe(false);
    expect(format(top!.atom)).toBe('!foo"bar"');
  });

  it("keeps a top-level bang-prefixed word as a symbol", () => {
    const [top] = parseAll("!foo", tk());
    expect(top!.bang).toBe(false);
    expect(format(top!.atom)).toBe("!foo");
  });

  it("keeps a double-bang-prefixed word as a symbol", () => {
    const [top] = parseAll("!!foo", tk());
    expect(top!.bang).toBe(false);
    expect(format(top!.atom)).toBe("!!foo");
  });

  it("still treats a top-level bang-prefixed string as a query", () => {
    const [top] = parseAll('!"hello"', tk());
    expect(top!.bang).toBe(true);
    expect(format(top!.atom)).toBe('"hello"');
  });

  it("still treats a top-level bang-prefixed expression as a query", () => {
    const [top] = parseAll("!(foo)", tk());
    expect(top!.bang).toBe(true);
    expect(format(top!.atom)).toBe("(foo)");
  });

  it("round-trips a type declaration", () => {
    const src = "(: if (-> Bool Atom Atom $t))";
    expect(format(parse(src, tk())!)).toBe(src);
  });

  it("rejects an unmatched top-level closing parenthesis without looping", () => {
    expect(() => parseAll("!(a))", tk())).toThrow("Unexpected right bracket");
  });

  it("parse∘format is identity up to atomEq for a nested program", () => {
    const t = tk();
    for (const { atom } of parseAll('(a (b $c) 3)\n!(g "s")', t)) {
      expect(atomEq(parse(format(atom), t)!, atom)).toBe(true);
    }
  });

  it("strings with control characters round-trip through format (readString inverts JSON escapes)", () => {
    const t = tk();
    // format prints strings via JSON.stringify, so readString must invert \r \b \f and \uXXXX, not just \n \t.
    for (const s of [
      "a\rb",
      "tab\tend",
      "line\nbreak",
      "bellhere",
      'quote"and\\backslash',
      "\b\f\r",
    ]) {
      const atom = parse(`(s ${JSON.stringify(s)})`, t)!;
      const back = parse(format(atom), t)!;
      expect(atomEq(back, atom)).toBe(true);
      expect(
        back.kind === "expr" && back.items[1]!.kind === "gnd" && back.items[1]!.value.g === "str"
          ? back.items[1]!.value.s
          : null,
      ).toBe(s);
    }
  });
});
