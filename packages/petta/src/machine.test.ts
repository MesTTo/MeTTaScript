// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: test that the machine's unify binds a plain variable to an attributed one whatever their ages and argument
// order, waking nothing, and the younger of two attributed variables to the older, waking the younger's attributes, as
// SWI-Prolog does.
// am[verifies c-attvar-bind-swi-1106]

import { describe, expect, it } from "vitest";
import { Machine } from "./machine";
import { Var, deref, mkVar, type Term } from "./terms";

describe("unify", () => {
  it("binds a plain variable to an attributed one, and the younger of two attributed ones, as SWI-Prolog does", () => {
    // [first made is attributed, second made is attributed, unify(second, first) instead of unify(first, second)]
    for (const [oldAttr, newAttr, swap] of [
      [true, false, false], [true, false, true], [false, true, false], [false, true, true],
      [true, true, false], [true, true, true],
    ] as const) {
      const m = new Machine();
      const older = mkVar(), younger = mkVar();
      if (oldAttr) older.attrs = new Map([["m", "o"]]);
      if (newAttr) younger.attrs = new Map([["m", "y"]]);
      expect(swap ? m.unify(younger, older) : m.unify(older, younger)).toBe(true);
      const r = deref(older) as Var;
      const wakeups = (m as unknown as { wakeups: Term[] }).wakeups.length;
      if (oldAttr !== newAttr) {
        // The attributed one survives, wherever it was made, and nothing wakes.
        expect(r.attrs?.get("m")).toBe(oldAttr ? "o" : "y");
        expect(wakeups).toBe(0);
      } else {
        // The younger is bound to the older, waking the younger's attributes.
        expect(r).toBe(older);
        expect(wakeups).toBe(1);
      }
    }
  });
});
