// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// The corpus representation: an entry has to survive being written as text and read back exactly, for
// every kind of value the codec can carry, and a reader has to refuse anything it does not recognize
// rather than let it through.

import "./index.js";
import { describe, expect, it } from "vitest";
import {
  atomEq,
  expr,
  format,
  gbool,
  gfloat,
  gint,
  gnd,
  gstr,
  gunit,
  sym,
  variable,
  type Atom,
} from "@mettascript/core";
import { corpusRegressionFact, parseCorpusEntries, renderCorpusEntry } from "./corpus.js";

function roundTrip(value: Atom): Atom | string {
  const rendered = renderCorpusEntry({ property: "p", value });
  if (!rendered.ok) return `render: ${rendered.reason}`;
  const parsed = parseCorpusEntries(rendered.value);
  if (!parsed.ok) return `parse: ${parsed.reason}`;
  if (parsed.value.length !== 1) return `parse: ${parsed.value.length} entries`;
  return parsed.value[0]!.value;
}

// One value per payload kind the codec emits, plus the cases where text is the risk: escapes, the
// float words, and an empty expression.
const VALUES: readonly (readonly [string, Atom])[] = [
  ["symbol", sym("Counter")],
  ["symbol needing care", sym('a b"c')],
  ["variable", variable("x")],
  ["integer", gint(1_000_000)],
  ["negative integer", gint(-42)],
  ["big integer", gint(9_007_199_254_740_993n)],
  ["float", gfloat(0.1)],
  ["negative zero", gfloat(-0)],
  ["infinity", gfloat(Number.POSITIVE_INFINITY)],
  ["negative infinity", gfloat(Number.NEGATIVE_INFINITY)],
  ["string", gstr("hello")],
  ["string with escapes", gstr('a"b\\c\nd\te')],
  ["unicode string", gstr("héllo ☃ 𝄞")],
  ["boolean", gbool(true)],
  ["unit", gunit],
  ["empty expression", expr([])],
  ["nested expression", expr([sym("A"), expr([sym("B"), gint(1), gfloat(2.5)]), gstr("c")])],
  ["deep expression", expr([sym("f"), expr([sym("f"), expr([sym("f"), gint(0)])])])],
];

describe("fuzz corpus entries", () => {
  it.each(VALUES)("round-trips a %s through text", (_label, value) => {
    const back = roundTrip(value);
    expect(typeof back === "string" ? back : format(back)).toBe(format(value));
    expect(typeof back !== "string" && atomEq(back, value)).toBe(true);
  });

  it("round-trips NaN, which has no source syntax at all", () => {
    // NaN never equals itself, so the check is on the bits: the entry stores the two 32-bit words.
    const rendered = renderCorpusEntry({ property: "p", value: gfloat(Number.NaN) });
    expect(rendered.ok && rendered.value).toContain("(Float64Bits 2146959360 0)");
    const back = roundTrip(gfloat(Number.NaN));
    expect(typeof back !== "string" && back.kind === "gnd" && back.value.g === "float").toBe(true);
    expect(
      typeof back !== "string" && back.kind === "gnd" && back.value.g === "float"
        ? Number.isNaN(back.value.n as number)
        : false,
    ).toBe(true);
  });

  it("keeps -0 apart from 0, which formatting alone would not", () => {
    const negative = roundTrip(gfloat(-0));
    expect(
      typeof negative !== "string" && negative.kind === "gnd" && negative.value.g === "float",
    ).toBe(true);
    if (typeof negative !== "string" && negative.kind === "gnd" && negative.value.g === "float") {
      expect(Object.is(negative.value.n, -0)).toBe(true);
    }
  });

  it("names the property and the entry format in the text", () => {
    const rendered = renderCorpusEntry({ property: "boundary", value: gint(5) });

    expect(rendered.ok && rendered.value).toContain(
      "(FuzzCorpusEntry 1 boundary (FuzzEncodedAtom 1 (Integer 5)))",
    );
    // A reader should be able to tell what the file is for without knowing the tool.
    expect(rendered.ok && rendered.value).toContain("; Commit this file");
  });

  it("refuses a value with no storable encoding", () => {
    // An external grounded value is a live host object, the shape a space handle takes: it has no text
    // form, so an entry must not claim to hold one.
    const handle = gnd({ g: "ext", kind: "Space", id: "&x" });

    expect(renderCorpusEntry({ property: "p", value: handle }).ok).toBe(false);
    const nested = renderCorpusEntry({ property: "p", value: expr([sym("Holds"), handle]) });
    // Refused wherever it sits, not only at the top: the encoder reports the first offending leaf.
    expect(nested.ok).toBe(false);
    expect(!nested.ok && nested.reason).toContain("no storable encoding");
    expect(!nested.ok && nested.reason).toContain("ExternalGrounded");
  });

  it("reads several entries from one file, in order", () => {
    const text = [
      "(FuzzCorpusEntry 1 first (FuzzEncodedAtom 1 (Integer 1)))",
      '(FuzzCorpusEntry 1 second (FuzzEncodedAtom 1 (Symbol "two")))',
    ].join("\n");
    const parsed = parseCorpusEntries(text);

    expect(parsed.ok && parsed.value.map((entry) => entry.property)).toEqual(["first", "second"]);
    expect(parsed.ok && format(parsed.value[1]!.value)).toBe("two");
  });

  it("refuses anything it does not recognize", () => {
    const cases: readonly (readonly [string, string, string])[] = [
      ["empty", "", "no entries"],
      ["comment only", "; nothing here\n", "no entries"],
      ["a query", '!(println! "ran")', "data, not queries"],
      [
        "wrong head",
        "(Regression 1 p (FuzzEncodedAtom 1 (Integer 1)))",
        "expected (FuzzCorpusEntry",
      ],
      ["wrong arity", "(FuzzCorpusEntry 1 p)", "expected (FuzzCorpusEntry"],
      ["future format", "(FuzzCorpusEntry 2 p (FuzzEncodedAtom 1 (Integer 1)))", "expected 1"],
      [
        "property not a symbol",
        '(FuzzCorpusEntry 1 "p" (FuzzEncodedAtom 1 (Integer 1)))',
        "symbol",
      ],
      ["payload not encoded", "(FuzzCorpusEntry 1 p 5)", "undecodable"],
      ["unknown payload tag", "(FuzzCorpusEntry 1 p (FuzzEncodedAtom 1 (Nope 5)))", "undecodable"],
      ["future codec", "(FuzzCorpusEntry 1 p (FuzzEncodedAtom 9 (Integer 1)))", "undecodable"],
      ["unbalanced", "(FuzzCorpusEntry 1 p", "unreadable"],
    ];

    for (const [label, text, reason] of cases) {
      const parsed = parseCorpusEntries(text);
      expect(parsed.ok, label).toBe(false);
      expect(!parsed.ok && parsed.reason, label).toContain(reason);
    }
  });

  it("refuses a whole file when one entry in it is wrong", () => {
    // Skipping the bad entry would drop a known failure from the run while still calling the run clean.
    const parsed = parseCorpusEntries(
      ["(FuzzCorpusEntry 1 good (FuzzEncodedAtom 1 (Integer 1)))", "(Something else)"].join("\n"),
    );

    expect(parsed.ok).toBe(false);
  });

  it("builds the fact that puts an entry in front of a run", () => {
    // The runner matches (FuzzRegression <property> <value> <replay>) in the space; the replay slot is
    // None because a stored entry carries the value only.
    expect(format(corpusRegressionFact({ property: "boundary", value: gint(5) }))).toBe(
      "(FuzzRegression boundary 5 None)",
    );
  });
});
